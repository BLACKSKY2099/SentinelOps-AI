import unittest
from unittest.mock import patch
from fastapi.testclient import TestClient

from app.api_server import app, clear_target_store, probe_target_url
from app.security import validate_target_url_ssrf, validate_github_repo_url


class TestSecurityValidation(unittest.TestCase):
    """Tests for SSRF prevention and GitHub repository URL validation."""

    def test_ssrf_rejects_non_http_scheme(self):
        is_safe, msg = validate_target_url_ssrf("ftp://example.com/file")
        self.assertFalse(is_safe)
        self.assertIn("Invalid URL scheme", msg)

        is_safe, msg = validate_target_url_ssrf("file:///etc/passwd")
        self.assertFalse(is_safe)

    def test_ssrf_rejects_localhost_and_loopback(self):
        is_safe, msg = validate_target_url_ssrf("http://localhost:8000")
        self.assertFalse(is_safe)
        self.assertIn("blocked", msg.lower())

        is_safe, msg = validate_target_url_ssrf("http://127.0.0.1:8000/api")
        self.assertFalse(is_safe)
        self.assertIn("loopback", msg.lower())

    def test_ssrf_rejects_private_ips(self):
        is_safe, msg = validate_target_url_ssrf("http://192.168.1.100")
        self.assertFalse(is_safe)
        self.assertIn("private", msg.lower())

        is_safe, msg = validate_target_url_ssrf("http://10.0.0.5:5000")
        self.assertFalse(is_safe)
        self.assertIn("private", msg.lower())

        is_safe, msg = validate_target_url_ssrf("http://172.16.0.1")
        self.assertFalse(is_safe)
        self.assertIn("private", msg.lower())

    def test_ssrf_rejects_cloud_metadata(self):
        is_safe, msg = validate_target_url_ssrf("http://169.254.169.254/latest/meta-data/")
        self.assertFalse(is_safe)
        self.assertIn("blocked", msg.lower())

        is_safe, msg = validate_target_url_ssrf("http://metadata.google.internal")
        self.assertFalse(is_safe)
        self.assertIn("blocked", msg.lower())

    def test_ssrf_accepts_valid_public_url(self):
        is_safe, _ = validate_target_url_ssrf("https://example.com")
        self.assertTrue(is_safe)

    def test_github_repo_validation_valid(self):
        valid, slug = validate_github_repo_url("https://github.com/user/repository")
        self.assertTrue(valid)
        self.assertEqual(slug, "user/repository")

        valid, slug = validate_github_repo_url("https://github.com/BLACKSKY2099/SentinelOps-AI.git")
        self.assertTrue(valid)
        self.assertEqual(slug, "BLACKSKY2099/SentinelOps-AI")

        valid, slug = validate_github_repo_url("http://github.com/owner/repo/")
        self.assertTrue(valid)
        self.assertEqual(slug, "owner/repo")

    def test_github_repo_validation_invalid(self):
        valid, msg = validate_github_repo_url("https://gitlab.com/user/repository")
        self.assertFalse(valid)
        self.assertIn("Invalid GitHub repository URL", msg)

        valid, msg = validate_github_repo_url("https://github.com/only-owner")
        self.assertFalse(valid)

        valid, msg = validate_github_repo_url("not-a-valid-url")
        self.assertFalse(valid)


class TestApiServerEndpoints(unittest.TestCase):
    """Integration tests for FastAPI Control Plane endpoints."""

    def setUp(self):
        clear_target_store()
        self.client = TestClient(app)

    def tearDown(self):
        clear_target_store()

    def test_api_health(self):
        response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["status"], "healthy")

    def test_target_retrieval_empty(self):
        response = self.client.get("/api/target")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertFalse(data["configured"])
        self.assertIsNone(data["target"])

    def test_target_configure_success(self):
        payload = {
            "name": "SentinelOps Demo",
            "demo_url": "https://example.com",
            "github_repo": "https://github.com/BLACKSKY2099/SentinelOps-AI",
            "branch": "main",
            "cloudwatch_log_group": "/aws/ops-pilot/sacrificial-app",
            "cloudwatch_log_stream": "production-errors",
            "aws_region": "us-east-1"
        }
        response = self.client.post("/api/target/configure", json=payload)
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["status"], "success")
        self.assertEqual(data["target"]["name"], "SentinelOps Demo")
        self.assertEqual(data["target"]["repo_slug"], "BLACKSKY2099/SentinelOps-AI")

        self.assertIn("application/json", response.headers.get("content-type", ""))
        self.assertTrue(len(response.text.strip()) > 0)

        # Verify GET /api/target now reflects the saved target
        get_resp = self.client.get("/api/target")
        self.assertEqual(get_resp.status_code, 200)
        self.assertIn("application/json", get_resp.headers.get("content-type", ""))
        get_data = get_resp.json()
        self.assertTrue(get_data["configured"])
        self.assertEqual(get_data["target"]["name"], "SentinelOps Demo")

    def test_target_configure_empty_name(self):
        payload = {
            "name": "   ",
            "demo_url": "https://example.com",
            "github_repo": "https://github.com/user/repo",
            "branch": "main"
        }
        response = self.client.post("/api/target/configure", json=payload)
        self.assertEqual(response.status_code, 400)
        self.assertIn("Application Name cannot be empty", response.json()["detail"])

    def test_target_configure_ssrf_blocked_url(self):
        payload = {
            "name": "Local App",
            "demo_url": "http://127.0.0.1:8000",
            "github_repo": "https://github.com/user/repo",
            "branch": "main"
        }
        response = self.client.post("/api/target/configure", json=payload)
        self.assertEqual(response.status_code, 400)
        self.assertIn("SSRF Protection", response.json()["detail"])

    def test_target_configure_invalid_github_url(self):
        payload = {
            "name": "GitLab App",
            "demo_url": "https://example.com",
            "github_repo": "https://gitlab.com/user/repo",
            "branch": "main"
        }
        response = self.client.post("/api/target/configure", json=payload)
        self.assertEqual(response.status_code, 400)
        self.assertIn("Invalid GitHub Repository", response.json()["detail"])

    def test_target_health_no_target_configured(self):
        response = self.client.get("/api/target/health")
        self.assertEqual(response.status_code, 400)
        self.assertIn("No target application configured", response.json()["detail"])

    def test_target_health_probe_success(self):
        # Configure target first
        self.client.post("/api/target/configure", json={
            "name": "SentinelOps Demo",
            "demo_url": "https://example.com",
            "github_repo": "https://github.com/user/repo",
            "branch": "main"
        })

        mock_probe = {
            "healthy": True,
            "status_code": 200,
            "latency_ms": 35.5,
            "error": None,
            "timestamp": "2026-10-04T22:00:00Z",
            "target_url": "https://example.com"
        }

        with patch("app.api_server.probe_target_url", return_value=mock_probe):
            response = self.client.get("/api/target/health")
            self.assertEqual(response.status_code, 200)
            data = response.json()
            self.assertTrue(data["healthy"])
            self.assertEqual(data["status_code"], 200)
            self.assertEqual(data["latency_ms"], 35.5)

    def test_target_health_probe_server_error(self):
        self.client.post("/api/target/configure", json={
            "name": "Failing App",
            "demo_url": "https://example.com",
            "github_repo": "https://github.com/user/repo",
            "branch": "main"
        })

        mock_probe = {
            "healthy": False,
            "status_code": 500,
            "latency_ms": 62.1,
            "error": "HTTP 500 Internal Server Error",
            "timestamp": "2026-10-04T22:00:00Z",
            "target_url": "https://example.com"
        }

        with patch("app.api_server.probe_target_url", return_value=mock_probe):
            response = self.client.get("/api/target/health")
            self.assertEqual(response.status_code, 200)
            data = response.json()
            self.assertFalse(data["healthy"])
            self.assertEqual(data["status_code"], 500)
            self.assertIn("HTTP 500", data["error"])

    def test_probe_target_url_ssrf_block(self):
        result = probe_target_url("http://127.0.0.1:9090")
        self.assertFalse(result["healthy"])
        self.assertIn("SSRF Security Block", result["error"])

    def test_agent_trigger_real(self):
        self.client.post("/api/target/configure", json={
            "name": "Live Target",
            "demo_url": "https://example.com",
            "github_repo": "https://github.com/user/repo",
            "branch": "main"
        })

        response = self.client.post("/api/agent/trigger")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["status"], "triggered")
        self.assertEqual(data["target"], "Live Target")
        self.assertEqual(data["cloudwatch_status"], "CloudWatch target not configured.")

    def test_apply_fix_endpoint_no_target(self):
        clear_target_store()
        payload = {
            "approved": True,
            "patch": {
                "file": "app/routes.py",
                "original": "return matching[0]",
                "replacement": "pass"
            }
        }
        resp = self.client.post("/api/agent/apply-fix", json=payload)
        self.assertEqual(resp.status_code, 400)
        self.assertIn("No target application configured", resp.json()["detail"])

    def test_apply_fix_endpoint_unapproved(self):
        self.client.post("/api/target/configure", json={
            "name": "Live Target",
            "demo_url": "https://example.com",
            "github_repo": "https://github.com/user/repo",
            "branch": "main"
        })
        payload = {
            "approved": False,
            "patch": {
                "file": "app/routes.py",
                "original": "return matching[0]",
                "replacement": "pass"
            }
        }
        resp = self.client.post("/api/agent/apply-fix", json=payload)
        self.assertEqual(resp.status_code, 400)
        self.assertIn("Explicit human approval is required", resp.json()["detail"])

    def test_apply_fix_endpoint_empty_original(self):
        self.client.post("/api/target/configure", json={
            "name": "Live Target",
            "demo_url": "https://example.com",
            "github_repo": "https://github.com/user/repo",
            "branch": "main"
        })
        payload = {
            "approved": True,
            "patch": {
                "file": "app/routes.py",
                "original": "",
                "replacement": "pass"
            }
        }
        resp = self.client.post("/api/agent/apply-fix", json=payload)
        self.assertEqual(resp.status_code, 400)
        self.assertIn("Patch must contain non-empty original code", resp.json()["detail"])

    def test_apply_fix_endpoint_success(self):
        self.client.post("/api/target/configure", json={
            "name": "SentinelOps Patient",
            "demo_url": "http://localhost:8001",
            "github_repo": "https://github.com/HITESHsai01/Patient",
            "branch": "main"
        })
        payload = {
            "approved": True,
            "patch": {
                "file": "app/routes.py",
                "original": "return matching[0]",
                "replacement": "if not matching: raise HTTPException(404)"
            }
        }
        mock_result = {
            "status": "validated",
            "branch": "sentinelops/fix/20261006_120000",
            "file": "app/routes.py",
            "message": "Patch validated successfully.",
            "tests": {"status": "PASS", "output": "Ran 6 tests in 0.05s OK"},
            "runtime_verification": {
                "health": {"path": "/api/health", "status_code": 200, "status": "200 OK"},
                "test_endpoint": {"path": "/api/user/999", "status_code": 404, "status": "404 Not Found"},
                "previous": "500 IndexError",
                "current": "404 User not found"
            }
        }
        with patch("app.api_server.apply_and_validate_fix", return_value=mock_result):
            resp = self.client.post("/api/agent/apply-fix", json=payload)
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertEqual(data["status"], "validated")
            self.assertEqual(data["branch"], "sentinelops/fix/20261006_120000")
            self.assertEqual(data["tests"]["status"], "PASS")
            self.assertEqual(data["runtime_verification"]["previous"], "500 IndexError")
            self.assertEqual(data["runtime_verification"]["current"], "404 User not found")


if __name__ == "__main__":
    unittest.main()
