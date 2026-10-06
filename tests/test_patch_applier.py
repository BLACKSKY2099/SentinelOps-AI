import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from typing import Optional
from fastapi.testclient import TestClient

from app.api_server import app, clear_target_store
from app.patch_applier import (
    apply_and_validate_fix,
    validate_patch_request,
    validate_file_and_original_text,
    create_isolated_branch,
    apply_patch_to_file,
    run_patient_test_suite,
    run_runtime_verification,
    safe_cleanup_dir
)


def _init_mock_git_repo(temp_dir: str, include_routes: bool = True, route_content: Optional[str] = None):
    """Helper to initialize a real git repository with a main branch for unit testing."""
    subprocess.run(["git", "init", "-b", "main"], cwd=temp_dir, capture_output=True, check=True)
    subprocess.run(["git", "config", "user.name", "Test Runner"], cwd=temp_dir, capture_output=True, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=temp_dir, capture_output=True, check=True)

    if include_routes:
        os.makedirs(os.path.join(temp_dir, "app"), exist_ok=True)
        default_routes = (
            "from fastapi import APIRouter\n"
            "router = APIRouter()\n\n"
            "@router.get('/api/user/{user_id}')\n"
            "def get_user_by_id(user_id: int):\n"
            "    matching = [u for u in [1, 2] if u == user_id]\n"
            "    # SENTINELOPS_TEST_BUG\n"
            "    return matching[0]\n"
        )
        content = route_content if route_content is not None else default_routes
        with open(os.path.join(temp_dir, "app", "routes.py"), "w", encoding="utf-8") as f:
            f.write(content)

    # Add a minimal test suite
    os.makedirs(os.path.join(temp_dir, "tests"), exist_ok=True)
    with open(os.path.join(temp_dir, "tests", "test_mock.py"), "w", encoding="utf-8") as f:
        f.write(
            "import unittest\n"
            "class MockTest(unittest.TestCase):\n"
            "    def test_ok(self):\n"
            "        self.assertTrue(True)\n"
        )

    subprocess.run(["git", "add", "."], cwd=temp_dir, capture_output=True, check=True)
    subprocess.run(["git", "commit", "-m", "Initial commit on main"], cwd=temp_dir, capture_output=True, check=True)


class TestPatchApplierRequirements(unittest.TestCase):
    """
    Comprehensive tests covering all 10 requirements from Stage 2:
    1. Valid patch application.
    2. Missing target file.
    3. Original text not found.
    4. Original text occurs more than once.
    5. Path traversal attempt.
    6. Wrong repository.
    7. Patch modifies unexpected file.
    8. Test failure.
    9. Approval required.
    10. Main branch remains untouched.
    """

    def setUp(self):
        clear_target_store()
        self.client = TestClient(app)
        self.temp_repo = tempfile.mkdtemp(prefix="sentinelops_test_repo_")
        self.target_config = {
            "name": "SentinelOps Patient",
            "demo_url": "http://localhost:8001",
            "github_repo": "https://github.com/HITESHsai01/Patient",
            "branch": "main"
        }
        # Configure target in API server
        self.client.post("/api/target/configure", json=self.target_config)

    def tearDown(self):
        clear_target_store()
        safe_cleanup_dir(self.temp_repo)

    def test_1_valid_patch_application(self):
        """1. Valid patch application: patch cleanly applied on isolated branch."""
        _init_mock_git_repo(self.temp_repo)

        patch_payload = {
            "approved": True,
            "patch": {
                "file": "app/routes.py",
                "original": "return matching[0]",
                "replacement": "if not matching:\n        return {'error': 'not found'}\n    return matching[0]"
            },
            "repo_url": "https://github.com/HITESHsai01/Patient",
            "branch": "main"
        }

        # Mock runtime verification to return verified
        mock_runtime = {
            "verified": True,
            "health": {"path": "/api/health", "status_code": 200, "status": "200 OK"},
            "test_endpoint": {"path": "/api/user/999", "status_code": 404, "status": "404 Not Found", "detail": "User not found"},
            "previous": "500 IndexError",
            "current": "404 User not found"
        }

        from unittest.mock import patch
        with patch("app.patch_applier.run_runtime_verification", return_value=mock_runtime):
            result = apply_and_validate_fix(patch_payload, self.target_config, local_repo_dir=self.temp_repo)

        self.assertEqual(result["status"], "validated")
        self.assertIn("sentinelops/fix/", result["branch"])
        self.assertEqual(result["file"], "app/routes.py")
        self.assertEqual(result["tests"]["status"], "PASS")

        # Verify target file has replacement
        target_path = os.path.join(self.temp_repo, "app", "routes.py")
        with open(target_path, "r", encoding="utf-8") as f:
            content = f.read()
        self.assertIn("if not matching:", content)

    def test_2_missing_target_file(self):
        """2. Missing target file: safe error reporting when file does not exist."""
        _init_mock_git_repo(self.temp_repo, include_routes=False)

        is_valid, msg, abs_file = validate_file_and_original_text(
            self.temp_repo,
            "app/routes.py",
            "return matching[0]"
        )
        self.assertFalse(is_valid)
        self.assertIn("does not exist", msg)
        self.assertIsNone(abs_file)

    def test_3_original_text_not_found(self):
        """3. Original text not found: aborts when original snippet is missing."""
        _init_mock_git_repo(self.temp_repo)

        is_valid, msg, _ = validate_file_and_original_text(
            self.temp_repo,
            "app/routes.py",
            "def non_existent_function_call(): pass"
        )
        self.assertFalse(is_valid)
        self.assertIn("Original text not found", msg)

    def test_4_original_text_occurs_more_than_once(self):
        """4. Original text occurs more than once: rejects ambiguous multi-match snippet."""
        duplicate_content = (
            "def f1():\n    return matching[0]\n\n"
            "def f2():\n    return matching[0]\n"
        )
        _init_mock_git_repo(self.temp_repo, route_content=duplicate_content)

        is_valid, msg, _ = validate_file_and_original_text(
            self.temp_repo,
            "app/routes.py",
            "return matching[0]"
        )
        self.assertFalse(is_valid)
        self.assertIn("occurs 2 times", msg)
        self.assertIn("Must occur exactly once", msg)

    def test_5_path_traversal_attempt(self):
        """5. Path traversal attempt: strictly rejects ../ or absolute file paths."""
        _init_mock_git_repo(self.temp_repo)

        # Attempt 1: leading ../
        patch_payload_1 = {
            "approved": True,
            "patch": {
                "file": "../../etc/passwd",
                "original": "foo",
                "replacement": "bar"
            }
        }
        is_valid, msg = validate_patch_request(patch_payload_1, self.target_config)
        self.assertFalse(is_valid)
        self.assertIn("Path traversal", msg)

        # Attempt 2: internal /../
        patch_payload_2 = {
            "approved": True,
            "patch": {
                "file": "app/../secrets.env",
                "original": "foo",
                "replacement": "bar"
            }
        }
        is_valid, msg = validate_patch_request(patch_payload_2, self.target_config)
        self.assertFalse(is_valid)
        self.assertIn("Path traversal", msg)

    def test_6_wrong_repository(self):
        """6. Wrong repository: rejects patch if repository does not match target."""
        patch_payload = {
            "approved": True,
            "patch": {
                "file": "app/routes.py",
                "original": "return matching[0]",
                "replacement": "pass"
            },
            "repo_url": "https://github.com/attacker/malicious-repo",
            "branch": "main"
        }
        is_valid, msg = validate_patch_request(patch_payload, self.target_config)
        self.assertFalse(is_valid)
        self.assertIn("Repository mismatch", msg)

    def test_7_patch_modifies_unexpected_file(self):
        """7. Patch modifies unexpected file: rejects modifications outside app/routes.py."""
        patch_payload = {
            "approved": True,
            "patch": {
                "file": "app/main.py",
                "original": "app = FastAPI()",
                "replacement": "pass"
            },
            "repo_url": "https://github.com/HITESHsai01/Patient",
            "branch": "main"
        }
        is_valid, msg = validate_patch_request(patch_payload, self.target_config)
        self.assertFalse(is_valid)
        self.assertIn("unexpected file", msg)
        self.assertIn("app/routes.py", msg)

    def test_8_test_failure_aborts_without_commit(self):
        """8. Test failure: when test suite fails, validation fails and does not commit."""
        _init_mock_git_repo(self.temp_repo)

        # Introduce a broken test into tests/
        with open(os.path.join(self.temp_repo, "tests", "test_mock.py"), "w", encoding="utf-8") as f:
            f.write(
                "import unittest\n"
                "class FailingTest(unittest.TestCase):\n"
                "    def test_fail(self):\n"
                "        self.assertEqual(1, 2, 'Intentional test suite failure')\n"
            )

        patch_payload = {
            "approved": True,
            "patch": {
                "file": "app/routes.py",
                "original": "return matching[0]",
                "replacement": "if not matching:\n        return None\n    return matching[0]"
            },
            "repo_url": "https://github.com/HITESHsai01/Patient",
            "branch": "main"
        }

        result = apply_and_validate_fix(patch_payload, self.target_config, local_repo_dir=self.temp_repo)
        self.assertEqual(result["status"], "validation_failed")
        self.assertEqual(result["tests"]["status"], "FAIL")
        self.assertIn("Patient test suite failed", result["message"])

    def test_9_approval_required(self):
        """9. Approval required: requests with approved=False are rejected with HTTP 400."""
        payload_unapproved = {
            "approved": False,
            "patch": {
                "file": "app/routes.py",
                "original": "return matching[0]",
                "replacement": "pass"
            }
        }
        resp = self.client.post("/api/agent/apply-fix", json=payload_unapproved)
        self.assertEqual(resp.status_code, 400)
        self.assertIn("Explicit human approval is required", resp.json()["detail"])

    def test_10_main_branch_remains_untouched(self):
        """10. Main branch remains untouched: main commit SHA and content identical before and after."""
        _init_mock_git_repo(self.temp_repo)

        # Get initial main SHA and file content
        sha_cmd = subprocess.run(["git", "rev-parse", "main"], cwd=self.temp_repo, capture_output=True, text=True, check=True)
        initial_sha = sha_cmd.stdout.strip()
        routes_path = os.path.join(self.temp_repo, "app", "routes.py")
        with open(routes_path, "r", encoding="utf-8") as f:
            initial_content = f.read()

        patch_payload = {
            "approved": True,
            "patch": {
                "file": "app/routes.py",
                "original": "return matching[0]",
                "replacement": "if not matching:\n        return {'error': 'none'}\n    return matching[0]"
            },
            "repo_url": "https://github.com/HITESHsai01/Patient",
            "branch": "main"
        }

        mock_runtime = {
            "verified": True,
            "health": {"path": "/api/health", "status_code": 200, "status": "200 OK"},
            "test_endpoint": {"path": "/api/user/999", "status_code": 404, "status": "404 Not Found", "detail": "User not found"},
            "previous": "500 IndexError",
            "current": "404 User not found"
        }

        # Mock clone_patient_isolated to clone from self.temp_repo to an isolated temp directory
        def mock_clone(url, branch="main"):
            iso_dir = tempfile.mkdtemp(prefix="sentinelops_iso_test_")
            subprocess.run(["git", "clone", "--branch", branch, self.temp_repo, iso_dir], capture_output=True, check=True)
            return True, iso_dir

        from unittest.mock import patch
        with patch("app.patch_applier.clone_patient_isolated", side_effect=mock_clone), \
             patch("app.patch_applier.run_runtime_verification", return_value=mock_runtime):
            result = apply_and_validate_fix(patch_payload, self.target_config)

        self.assertEqual(result["status"], "validated")

        # Verify main branch in source repo was not touched at all
        post_sha_cmd = subprocess.run(["git", "rev-parse", "main"], cwd=self.temp_repo, capture_output=True, text=True, check=True)
        post_sha = post_sha_cmd.stdout.strip()

        with open(routes_path, "r", encoding="utf-8") as f:
            post_content = f.read()

        self.assertEqual(initial_sha, post_sha, "Main branch HEAD commit SHA changed!")
        self.assertEqual(initial_content, post_content, "Main branch content was modified!")


if __name__ == "__main__":
    unittest.main()
