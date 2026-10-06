import base64
import json
import os
import unittest
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient

from app.api_server import app, clear_target_store, _last_validated_patch
from app.github_client import (
    get_github_token,
    parse_repo_slug,
    validate_repo_and_branch,
    verify_patch_integrity,
    create_github_branch,
    commit_file_to_branch,
    create_pull_request,
    execute_create_pr_pipeline,
    ALLOWED_OWNER,
    ALLOWED_REPO,
    ALLOWED_BASE_BRANCH,
    ALLOWED_TARGET_FILE
)


class TestGitHubPRIntegration(unittest.TestCase):
    """
    Comprehensive tests for Stage 3: GitHub Pull Request Integration.
    Covers all 15 requirements specified for Stage 3.
    """

    def setUp(self):
        clear_target_store()
        self.client = TestClient(app)
        self.target_config = {
            "name": "SentinelOps Patient",
            "demo_url": "http://localhost:8001",
            "github_repo": "https://github.com/HITESHsai01/Patient",
            "branch": "main"
        }
        self.client.post("/api/target/configure", json=self.target_config)

        self.mock_stage2_patch = {
            "status": "validated",
            "file": "app/routes.py",
            "branch": "sentinelops/fix/20261005_120000",
            "patch": {
                "file": "app/routes.py",
                "original": "return matching[0]",
                "replacement": "if not matching:\n        from fastapi import HTTPException\n        raise HTTPException(status_code=404, detail=\"User not found\")\n    return matching[0]"
            },
            "tests": {"status": "PASS"},
            "runtime_verification": {"previous": "500 IndexError", "current": "404 User not found"}
        }

    def tearDown(self):
        clear_target_store()

    def test_1_github_auth_missing(self):
        """1. GitHub authentication missing: fails safely with clear message."""
        with patch.dict(os.environ, {}, clear=True):
            res = execute_create_pr_pipeline(self.mock_stage2_patch, self.target_config)
            self.assertEqual(res["status"], "auth_error")
            self.assertIn("GitHub write authentication is not configured", res["message"])

    def test_2_unauthorized_repository_rejected(self):
        """2. Unauthorized repository rejected: strictly locked to HITESHsai01/Patient."""
        is_valid, msg = validate_repo_and_branch("attacker", "malicious-repo", "main")
        self.assertFalse(is_valid)
        self.assertIn("Unauthorized repository", msg)

        # Via pipeline
        bad_config = {
            "github_repo": "https://github.com/other-user/Patient",
            "branch": "main"
        }
        res = execute_create_pr_pipeline(self.mock_stage2_patch, bad_config, github_token="dummy_token")
        self.assertEqual(res["status"], "unauthorized_target")
        self.assertIn("Unauthorized repository", res["message"])

    def test_3_unauthorized_branch_rejected(self):
        """3. Unauthorized branch rejected: only 'main' is permitted."""
        is_valid, msg = validate_repo_and_branch("HITESHsai01", "Patient", "develop")
        self.assertFalse(is_valid)
        self.assertIn("Unauthorized base branch", msg)

        bad_branch_config = {
            "github_repo": "https://github.com/HITESHsai01/Patient",
            "branch": "staging"
        }
        res = execute_create_pr_pipeline(self.mock_stage2_patch, bad_branch_config, github_token="dummy_token")
        self.assertEqual(res["status"], "unauthorized_target")
        self.assertIn("Unauthorized base branch", res["message"])

    def test_4_main_branch_cannot_be_directly_modified(self):
        """4. Main branch cannot be directly modified: commit to main is forbidden."""
        mock_http = MagicMock()
        ok, msg, data = commit_file_to_branch(
            mock_http, "HITESHsai01", "Patient", "app/routes.py",
            "code", "main", "blob_sha", "commit msg"
        )
        self.assertFalse(ok)
        self.assertIn("Direct commits to main branch are forbidden", msg)
        self.assertIsNone(data)
        # Verify no HTTP request was made
        mock_http.put.assert_not_called()

    def test_5_stage_2_validation_required(self):
        """5. Stage 2 validation required: endpoint rejects PR if Stage 2 didn't validate."""
        # Target configured but no Stage 2 validation ran
        payload = {"approved": True}
        resp = self.client.post("/api/agent/create-pr", json=payload)
        self.assertEqual(resp.status_code, 400)
        self.assertIn("Stage 2 fix validation has not been performed", resp.json()["detail"])

    def test_6_stale_patch_rejected(self):
        """6. Stale patch rejected: aborts with PATCH_STALE if remote source changed."""
        remote_main_code = (
            "# Remote code has been updated by another commit\n"
            "def get_user_by_id(user_id: int):\n"
            "    user = database.find(user_id)\n"
            "    return user\n"
        )
        # 'return matching[0]' is missing from remote_main_code
        ok, msg, patched = verify_patch_integrity(remote_main_code, self.mock_stage2_patch["patch"], "app/routes.py")
        self.assertFalse(ok)
        self.assertIn("PATCH_STALE", msg)
        self.assertIsNone(patched)

    def test_7_valid_branch_creation(self):
        """7. Valid branch creation: creates sentinelops/fix/<timestamp> pointing to base SHA."""
        mock_http = MagicMock()
        mock_resp = MagicMock()
        mock_resp.status_code = 201
        mock_resp.json.return_value = {
            "ref": "refs/heads/sentinelops/fix/20261005_123456",
            "object": {"sha": "base_sha_12345"}
        }
        mock_http.post.return_value = mock_resp

        ok, msg, data = create_github_branch(
            mock_http, "HITESHsai01", "Patient",
            "sentinelops/fix/20261005_123456", "base_sha_12345"
        )
        self.assertTrue(ok)
        self.assertEqual(data["object"]["sha"], "base_sha_12345")
        mock_http.post.assert_called_once()
        call_args = mock_http.post.call_args
        self.assertIn("sentinelops/fix/20261005_123456", call_args[1]["json"]["ref"])

    def test_8_valid_commit_creation(self):
        """8. Valid commit creation: commits patched file to isolated branch."""
        mock_http = MagicMock()
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "commit": {"sha": "new_commit_sha_98765"},
            "content": {"name": "routes.py"}
        }
        mock_http.put.return_value = mock_resp

        ok, msg, data = commit_file_to_branch(
            mock_http, "HITESHsai01", "Patient", "app/routes.py",
            "patched code", "sentinelops/fix/20261005_123456",
            "old_blob_sha", "fix: handle missing user"
        )
        self.assertTrue(ok)
        self.assertEqual(data["sha"], "new_commit_sha_98765")
        mock_http.put.assert_called_once()
        put_payload = mock_http.put.call_args[1]["json"]
        self.assertEqual(put_payload["branch"], "sentinelops/fix/20261005_123456")
        self.assertEqual(put_payload["message"], "fix: handle missing user")

    def test_9_pr_creation(self):
        """9. PR creation: creates Pull Request targeting main."""
        mock_http = MagicMock()
        mock_resp = MagicMock()
        mock_resp.status_code = 201
        mock_resp.json.return_value = {
            "number": 42,
            "html_url": "https://github.com/HITESHsai01/Patient/pull/42",
            "state": "open"
        }
        mock_http.post.return_value = mock_resp

        ok, msg, data = create_pull_request(
            mock_http, "HITESHsai01", "Patient",
            "fix: handle missing user endpoint error",
            "PR Body", "sentinelops/fix/20261005_123456",
            base_branch="main"
        )
        self.assertTrue(ok)
        self.assertEqual(data["number"], 42)
        self.assertEqual(data["html_url"], "https://github.com/HITESHsai01/Patient/pull/42")
        self.assertEqual(data["state"], "open")
        post_payload = mock_http.post.call_args[1]["json"]
        self.assertEqual(post_payload["base"], "main")
        self.assertEqual(post_payload["head"], "sentinelops/fix/20261005_123456")

    def test_10_github_api_failure_handled_safely(self):
        """10. GitHub API failure handled safely: surfaces error cleanly without crashing."""
        mock_http = MagicMock()
        mock_resp = MagicMock()
        mock_resp.status_code = 500
        mock_resp.text = "Internal GitHub Server Error"
        mock_http.get.return_value = mock_resp

        with patch.dict(os.environ, {"GITHUB_TOKEN": "test_token"}):
            res = execute_create_pr_pipeline(
                self.mock_stage2_patch, self.target_config,
                github_token="test_token", http_client=mock_http
            )
            self.assertEqual(res["status"], "github_api_error")
            self.assertIn("Failed to retrieve main branch HEAD", res["message"])

    def test_11_token_never_appears_in_api_response(self):
        """11. Token never appears in API response."""
        secret_token = "ghp_VERY_SECRET_PAT_TOKEN_1234567890ABC"

        mock_http = MagicMock()
        # Mock error containing token in exception string
        mock_http.get.side_effect = Exception(f"Failed with auth header Bearer {secret_token}")

        res = execute_create_pr_pipeline(
            self.mock_stage2_patch, self.target_config,
            github_token=secret_token, http_client=mock_http
        )
        serialized_res = json.dumps(res)
        self.assertNotIn(secret_token, serialized_res)

    def test_12_token_never_appears_in_frontend_state(self):
        """12. Token never appears in frontend configuration endpoints."""
        target_resp = self.client.get("/api/target")
        self.assertEqual(target_resp.status_code, 200)
        serialized = json.dumps(target_resp.json())
        self.assertNotIn("token", serialized.lower())
        self.assertNotIn("github_token", serialized.lower())

        status_resp = self.client.get("/api/agent/status")
        self.assertEqual(status_resp.status_code, 200)
        self.assertNotIn("token", json.dumps(status_resp.json()).lower())

    def test_13_only_intended_file_can_be_committed(self):
        """13. Only intended file can be committed: app/main.py or others are rejected."""
        ok, msg, _ = verify_patch_integrity(
            "app = FastAPI()",
            {"original": "app = FastAPI()", "replacement": "pass"},
            "app/main.py"
        )
        self.assertFalse(ok)
        self.assertIn("Only modifications to 'app/routes.py' are permitted", msg)

    def test_14_pr_targets_main(self):
        """14. PR targets main: attempting non-main base branch is blocked."""
        mock_http = MagicMock()
        ok, msg, _ = create_pull_request(
            mock_http, "HITESHsai01", "Patient",
            "title", "body", "sentinelops/fix/123",
            base_branch="develop"
        )
        self.assertFalse(ok)
        self.assertIn("PR base branch must be strictly 'main'", msg)
        mock_http.post.assert_not_called()

    def test_15_pr_is_never_automatically_merged(self):
        """15. PR is never automatically merged: state remains 'open', no merge endpoint invoked."""
        mock_http = MagicMock()

        # 1. Main branch head
        mock_ref_resp = MagicMock()
        mock_ref_resp.status_code = 200
        mock_ref_resp.json.return_value = {"object": {"sha": "main_head_sha_123"}}

        # 2. Remote file content
        valid_routes_code = (
            "def get_user_by_id(user_id: int):\n"
            "    matching = [u for u in [1, 2] if u == user_id]\n"
            "    return matching[0]\n"
        )
        mock_file_resp = MagicMock()
        mock_file_resp.status_code = 200
        mock_file_resp.json.return_value = {
            "content": base64.b64encode(valid_routes_code.encode("utf-8")).decode("ascii"),
            "sha": "blob_sha_123",
            "path": "app/routes.py"
        }

        # 3. Create branch
        mock_branch_resp = MagicMock()
        mock_branch_resp.status_code = 201
        mock_branch_resp.json.return_value = {"ref": "refs/heads/sentinelops/fix/test"}

        # 4. Commit file
        mock_commit_resp = MagicMock()
        mock_commit_resp.status_code = 201
        mock_commit_resp.json.return_value = {"commit": {"sha": "new_commit_sha_555"}}

        # 5. Create PR
        mock_pr_resp = MagicMock()
        mock_pr_resp.status_code = 201
        mock_pr_resp.json.return_value = {
            "number": 7,
            "html_url": "https://github.com/HITESHsai01/Patient/pull/7",
            "state": "open"
        }

        mock_http.get.side_effect = [mock_ref_resp, mock_file_resp]
        mock_http.post.side_effect = [mock_branch_resp, mock_pr_resp]
        mock_http.put.return_value = mock_commit_resp

        res = execute_create_pr_pipeline(
            self.mock_stage2_patch, self.target_config,
            github_token="ghp_test_token_12345",
            http_client=mock_http
        )

        self.assertEqual(res["status"], "pr_created")
        self.assertEqual(res["pr_number"], 7)
        self.assertEqual(res["pr_url"], "https://github.com/HITESHsai01/Patient/pull/7")
        self.assertEqual(res["base_branch"], "main")

        # Verify no PUT /merge or POST /merge was ever called
        for call in mock_http.put.call_args_list:
            url_called = call[0][0] if call[0] else ""
            self.assertNotIn("/merge", url_called)

        for call in mock_http.post.call_args_list:
            url_called = call[0][0] if call[0] else ""
            self.assertNotIn("/merge", url_called)


if __name__ == "__main__":
    unittest.main()
