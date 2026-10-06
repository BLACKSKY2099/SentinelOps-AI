import os
import shutil
import tempfile
import unittest
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient
import httpx

from app.api_server import app, clear_target_store
from app.patient_client import check_patient_health, run_patient_diagnostic
from app.repo_inspector import inspect_patient_repository, _analyze_routes_code
from app.security import validate_target_url_ssrf


class TestPatientSecurityAndConfiguration(unittest.TestCase):
    """Tests for target configuration, retrieval, and SSRF rules for local patient."""

    def setUp(self):
        clear_target_store()
        self.client = TestClient(app)

    def tearDown(self):
        clear_target_store()

    def test_ssrf_allows_localhost_8001_in_local_dev(self):
        """Verify http://localhost:8001 and http://127.0.0.1:8001 are explicitly permitted."""
        is_safe, msg = validate_target_url_ssrf("http://localhost:8001")
        self.assertTrue(is_safe)
        self.assertIn("8001", msg)

        is_safe, msg = validate_target_url_ssrf("http://127.0.0.1:8001")
        self.assertTrue(is_safe)

    def test_ssrf_rejects_localhost_non_8001(self):
        """Verify localhost on port 8000 or other ports is still blocked."""
        is_safe, _ = validate_target_url_ssrf("http://localhost:8000")
        self.assertFalse(is_safe)

        is_safe, _ = validate_target_url_ssrf("http://127.0.0.1:3000")
        self.assertFalse(is_safe)

    def test_ssrf_rejects_localhost_8001_when_local_dev_disabled(self):
        """Verify production mode rejects all localhost targets including 8001."""
        is_safe, msg = validate_target_url_ssrf("http://localhost:8001", allow_local_patient=False)
        self.assertFalse(is_safe)
        self.assertIn("blocked", msg.lower())

    def test_configure_patient_target_success(self):
        """Test configuring SentinelOps Patient target."""
        payload = {
            "name": "SentinelOps Patient",
            "demo_url": "http://localhost:8001",
            "github_repo": "https://github.com/HITESHsai01/Patient",
            "branch": "main"
        }
        resp = self.client.post("/api/target/configure", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["status"], "success")
        self.assertEqual(data["target"]["name"], "SentinelOps Patient")
        self.assertEqual(data["target"]["demo_url"], "http://localhost:8001")
        self.assertEqual(data["target"]["github_repo"], "https://github.com/HITESHsai01/Patient")
        self.assertEqual(data["target"]["branch"], "main")

    def test_get_target_empty_and_configured(self):
        """Test GET /api/target before and after configuration."""
        # Unconfigured
        resp = self.client.get("/api/target")
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(resp.json()["configured"])

        # Configure
        self.client.post("/api/target/configure", json={
            "name": "SentinelOps Patient",
            "demo_url": "http://localhost:8001",
            "github_repo": "https://github.com/HITESHsai01/Patient",
            "branch": "main"
        })

        # Configured
        resp = self.client.get("/api/target")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertTrue(data["configured"])
        self.assertEqual(data["name"], "SentinelOps Patient")
        self.assertEqual(data["demo_url"], "http://localhost:8001")
        self.assertEqual(data["github_repo"], "https://github.com/HITESHsai01/Patient")
        self.assertEqual(data["branch"], "main")


class TestPatientHealthAndDiagnostic(unittest.TestCase):
    """Tests for health check and diagnostic endpoints."""

    def setUp(self):
        clear_target_store()
        self.client = TestClient(app)
        self.client.post("/api/target/configure", json={
            "name": "SentinelOps Patient",
            "demo_url": "http://localhost:8001",
            "github_repo": "https://github.com/HITESHsai01/Patient",
            "branch": "main"
        })

    def tearDown(self):
        clear_target_store()

    def test_target_health_healthy(self):
        """Test patient health check when patient returns HTTP 200."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.reason_phrase = "OK"

        with patch("app.patient_client.httpx.Client.get", return_value=mock_resp):
            res = check_patient_health("http://localhost:8001")
            self.assertEqual(res["status"], "healthy")
            self.assertEqual(res["http_status"], 200)
            self.assertIsNotNone(res["latency_ms"])

        # Also verify API endpoint returns it
        mock_telemetry = {
            "status": "healthy",
            "http_status": 200,
            "latency_ms": 15.2,
            "target_url": "http://localhost:8001/api/health",
            "error": None
        }
        with patch("app.api_server.probe_target_url", return_value=mock_telemetry):
            resp = self.client.get("/api/target/health")
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.json()["status"], "healthy")

    def test_target_health_unreachable(self):
        """Test patient health check when patient service is offline."""
        with patch("app.patient_client.httpx.Client.get", side_effect=httpx.ConnectError("Connection refused")):
            res = check_patient_health("http://localhost:8001")
            self.assertEqual(res["status"], "unreachable")
            self.assertIsNone(res["http_status"])
            self.assertIn("connection error", res["error"].lower())

    def test_run_diagnostic_distinguishes_healthy_patient_and_broken_endpoint(self):
        """
        Verify that run_patient_diagnostic detects:
        1. /api/health -> healthy (HTTP 200)
        2. /api/user/999 -> failed (HTTP 500, IndexError, list index out of range)
        """
        def mock_get(url, **kwargs):
            mock = MagicMock()
            if "/api/health" in url:
                mock.status_code = 200
                mock.reason_phrase = "OK"
                mock.json.return_value = {"status": "healthy", "service": "sentinelops-patient"}
            elif "/api/user/999" in url:
                mock.status_code = 500
                mock.reason_phrase = "Internal Server Error"
                mock.text = "Internal Server Error"
                mock.json.return_value = {
                    "error": "Internal Server Error",
                    "exception_type": "IndexError",
                    "message": "list index out of range",
                    "path": "/api/user/999"
                }
            return mock

        with patch("app.patient_client.httpx.Client.get", side_effect=mock_get):
            data = run_patient_diagnostic("http://localhost:8001", target_name="SentinelOps Patient")

            self.assertEqual(data["target"], "SentinelOps Patient")
            # Patient health remains healthy!
            self.assertEqual(data["health"]["status"], "healthy")
            self.assertEqual(data["health"]["http_status"], 200)

            # Known test endpoint fails with IndexError
            self.assertEqual(len(data["tests"]), 1)
            test_res = data["tests"][0]
            self.assertEqual(test_res["path"], "/api/user/999")
            self.assertEqual(test_res["status"], "failed")
            self.assertEqual(test_res["http_status"], 500)
            self.assertEqual(test_res["error_type"], "IndexError")
            self.assertEqual(test_res["message"], "list index out of range")

        # Also verify via API endpoint
        with patch("app.api_server.run_patient_diagnostic", return_value=data):
            resp = self.client.post("/api/diagnostic/run")
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.json()["target"], "SentinelOps Patient")
            self.assertEqual(resp.json()["tests"][0]["error_type"], "IndexError")


class TestRepositoryInspectionAndDiagnosis(unittest.TestCase):
    """Tests for read-only GitHub repository inspection and diagnosis generation."""

    def setUp(self):
        clear_target_store()
        self.client = TestClient(app)
        self.client.post("/api/target/configure", json={
            "name": "SentinelOps Patient",
            "demo_url": "http://localhost:8001",
            "github_repo": "https://github.com/HITESHsai01/Patient",
            "branch": "main"
        })

    def tearDown(self):
        clear_target_store()

    def test_analyze_routes_code_discovers_line_number(self):
        """Test discovering exact line number from routes.py code dynamically."""
        sample_code = (
            "from fastapi import APIRouter\n"
            "router = APIRouter()\n"
            "@router.get('/api/user/{user_id}')\n"
            "def get_user_by_id(user_id: int):\n"
            "    matching = [u for u in USERS if u['id'] == user_id]\n"
            "    # SENTINELOPS_TEST_BUG\n"
            "    return matching[0]\n"
        )
        res = _analyze_routes_code(sample_code)
        self.assertEqual(res["status"], "bug_found")
        self.assertEqual(res["file"], "app/routes.py")
        self.assertEqual(res["line"], 6)  # exact line of marker
        self.assertEqual(res["failing_code_line"], 7)  # exact line of return matching[0]
        self.assertIn("matching[0]", res["root_cause"])
        self.assertIn("404", res["suggested_fix"])

    def test_repo_inspection_safe_cleanup(self):
        """Verify inspection cleans up temporary directories and does not leave files behind."""
        tracked_temp_dirs = []
        original_mkdtemp = tempfile.mkdtemp

        def record_mkdtemp(*args, **kwargs):
            d = original_mkdtemp(*args, **kwargs)
            tracked_temp_dirs.append(d)
            return d

        with patch("tempfile.mkdtemp", side_effect=record_mkdtemp):
            # Use raw fallback mock or actual fetch
            mock_resp = MagicMock()
            mock_resp.status_code = 200
            mock_resp.text = (
                "@router.get('/api/user/{user_id}')\n"
                "# SENTINELOPS_TEST_BUG\n"
                "return matching[0]\n"
            )
            with patch("httpx.Client.get", return_value=mock_resp), \
                 patch("subprocess.run", side_effect=FileNotFoundError("git not in PATH")):
                res = inspect_patient_repository("https://github.com/HITESHsai01/Patient", "main")
                self.assertEqual(res["status"], "bug_found")
                self.assertEqual(res["file"], "app/routes.py")

        # Verify all created temporary directories were cleaned up
        for d in tracked_temp_dirs:
            self.assertFalse(os.path.exists(d), f"Temporary directory {d} was not cleaned up!")

    def test_agent_diagnose_endpoint(self):
        """
        Verify POST /api/agent/diagnose produces structured diagnosis:
        - status: bug_found
        - target: SentinelOps Patient
        - exception: IndexError
        - message: list index out of range
        - file: app/routes.py
        - line: discovered line number
        - root_cause: accesses matching[0]...
        - suggested_fix: return 404...
        """
        mock_diag = {
            "target": "SentinelOps Patient",
            "health": {"status": "healthy", "http_status": 200},
            "tests": [
                {
                    "path": "/api/user/999",
                    "status": "failed",
                    "http_status": 500,
                    "error_type": "IndexError",
                    "message": "list index out of range"
                }
            ]
        }

        mock_repo = {
            "status": "bug_found",
            "file": "app/routes.py",
            "line": 57,
            "root_cause": "The code accesses matching[0] without checking whether the list contains a matching user.",
            "suggested_fix": "Return a 404 response when no matching user exists.",
            "snippet": ["# SENTINELOPS_TEST_BUG", "return matching[0]"]
        }

        with patch("app.api_server.run_patient_diagnostic", return_value=mock_diag), \
             patch("app.api_server.inspect_patient_repository", return_value=mock_repo):
            resp = self.client.post("/api/agent/diagnose")
            self.assertEqual(resp.status_code, 200)
            data = resp.json()

            self.assertEqual(data["status"], "bug_found")
            self.assertEqual(data["target"], "SentinelOps Patient")
            self.assertEqual(data["exception"], "IndexError")
            self.assertEqual(data["message"], "list index out of range")
            self.assertEqual(data["file"], "app/routes.py")
            self.assertEqual(data["line"], 57)
            self.assertIn("matching[0]", data["root_cause"])
            self.assertIn("404", data["suggested_fix"])


if __name__ == "__main__":
    unittest.main()
