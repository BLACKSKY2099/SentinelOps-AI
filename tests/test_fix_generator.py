import json
import unittest
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient
from botocore.exceptions import ClientError, NoCredentialsError, EndpointConnectionError

from app.api_server import app, clear_target_store
from app.fix_generator import (
    generate_bedrock_fix,
    parse_bedrock_json_response,
    sanitize_error_message,
    DEFAULT_BEDROCK_MODEL_ID,
    DEFAULT_AWS_REGION
)


class TestFixGeneratorUnits(unittest.TestCase):
    """Unit tests for Bedrock parsing, sanitization, and fix generation logic."""

    def test_sanitize_error_message_redacts_credentials(self):
        """Verify error messages redact AWS access keys and GitHub tokens."""
        raw_err = "Auth failed with AKIA1234567890ABCDEF and token ghp_123456789012345678901234567890123456"
        sanitized = sanitize_error_message(raw_err)
        self.assertNotIn("AKIA1234567890ABCDEF", sanitized)
        self.assertNotIn("ghp_123456789012345678901234567890123456", sanitized)
        self.assertIn("[REDACTED_AWS_KEY]", sanitized)
        self.assertIn("[REDACTED_GH_TOKEN]", sanitized)

    def test_parse_bedrock_json_response_direct_json(self):
        """Verify parsing direct JSON output from Bedrock."""
        raw = json.dumps({
            "diagnosis": "IndexError on empty list",
            "root_cause": "matching[0] raises when user not found",
            "file": "app/routes.py",
            "proposed_fix": {
                "original_code": "return matching[0]",
                "replacement_code": "if not matching:\n        return {'error': 'not found'}\n    return matching[0]"
            },
            "explanation": "Safely check if matching is empty before index 0.",
            "confidence": 0.98
        })
        res = parse_bedrock_json_response(raw)
        self.assertEqual(res["file"], "app/routes.py")
        self.assertEqual(res["proposed_fix"]["original_code"], "return matching[0]")
        self.assertEqual(res["confidence"], 0.98)

    def test_parse_bedrock_json_response_markdown_code_fence(self):
        """Verify parsing JSON wrapped in markdown code fence."""
        raw = """Here is the safe patch proposal:
```json
{
  "diagnosis": "IndexError fix",
  "root_cause": "List index out of range",
  "file": "app/routes.py",
  "proposed_fix": {
    "original_code": "return matching[0]",
    "replacement_code": "if not matching:\\n        raise HTTPException(status_code=404, detail=\\"User not found\\")\\n    return matching[0]"
  },
  "explanation": "Raise 404 on missing record.",
  "confidence": 0.95
}
```
Let me know if you would like me to review further."""
        res = parse_bedrock_json_response(raw)
        self.assertEqual(res["file"], "app/routes.py")
        self.assertIn("HTTPException", res["proposed_fix"]["replacement_code"])
        self.assertEqual(res["confidence"], 0.95)

    def test_parse_bedrock_json_response_invalid_raises_value_error(self):
        """Verify invalid or unparseable JSON raises ValueError."""
        with self.assertRaises(ValueError):
            parse_bedrock_json_response("No JSON object could be decoded here.")

    def test_bedrock_unavailable_returns_safe_status(self):
        """Verify Bedrock client errors return status='ai_unavailable' without crashing."""
        context = {
            "target": "SentinelOps Patient",
            "file": "app/routes.py",
            "line": 57,
            "exception": "IndexError",
            "error_message": "list index out of range",
            "root_cause": "matching[0] accessed on empty list",
            "suggested_fix": "Return 404",
            "source_code": "return matching[0]"
        }

        mock_client = MagicMock()
        mock_client.converse.side_effect = NoCredentialsError()

        result = generate_bedrock_fix(context, bedrock_client=mock_client)
        self.assertEqual(result["status"], "ai_unavailable")
        self.assertIn("Amazon Bedrock inference error", result["error"])

    def test_bedrock_successful_fix_generation(self):
        """Verify successful Bedrock call returns structured proposal."""
        context = {
            "target": "SentinelOps Patient",
            "file": "app/routes.py",
            "line": 57,
            "exception": "IndexError",
            "error_message": "list index out of range",
            "root_cause": "matching[0] is accessed when no matching user exists",
            "suggested_fix": "Return 404 response",
            "source_code": "matching = [u for u in USERS if u['id'] == user_id]\nreturn matching[0]"
        }

        mock_client = MagicMock()
        mock_output = {
            "output": {
                "message": {
                    "content": [
                        {
                            "text": json.dumps({
                                "diagnosis": "IndexError in get_user_by_id",
                                "root_cause": "matching[0] is accessed when no matching user exists",
                                "file": "app/routes.py",
                                "proposed_fix": {
                                    "original_code": "return matching[0]",
                                    "replacement_code": "if not matching:\n        from fastapi import HTTPException\n        raise HTTPException(status_code=404, detail=\"User not found\")\n    return matching[0]"
                                },
                                "explanation": "Checks if matching list contains elements before index 0 lookup.",
                                "confidence": 0.95
                            })
                        }
                    ]
                }
            }
        }
        mock_client.converse.return_value = mock_output

        result = generate_bedrock_fix(context, bedrock_client=mock_client)
        self.assertEqual(result["status"], "fix_proposed")
        self.assertEqual(result["target"], "SentinelOps Patient")
        self.assertEqual(result["file"], "app/routes.py")
        self.assertEqual(result["line"], 57)
        self.assertEqual(result["exception"], "IndexError")
        self.assertEqual(result["proposed_fix"]["original_code"], "return matching[0]")
        self.assertIn("HTTPException", result["proposed_fix"]["replacement_code"])
        self.assertEqual(result["confidence"], 0.95)


class TestApiServerGenerateFixEndpoint(unittest.TestCase):
    """Integration tests for POST /api/agent/generate-fix."""

    def setUp(self):
        clear_target_store()
        self.client = TestClient(app)

    def tearDown(self):
        clear_target_store()

    def test_generate_fix_missing_target_handling(self):
        """Verify endpoint returns 400 when no target is configured."""
        resp = self.client.post("/api/agent/generate-fix")
        self.assertEqual(resp.status_code, 400)
        self.assertIn("No target application configured", resp.json()["detail"])

    def test_generate_fix_diagnostic_failure_handling(self):
        """Verify endpoint returns diagnostic_failed when patient is unreachable."""
        self.client.post("/api/target/configure", json={
            "name": "SentinelOps Patient",
            "demo_url": "http://localhost:8001",
            "github_repo": "https://github.com/HITESHsai01/Patient",
            "branch": "main"
        })

        mock_diag = {
            "target": "SentinelOps Patient",
            "health": {
                "status": "unreachable",
                "http_status": None,
                "error": "Connection refused"
            },
            "tests": []
        }

        with patch("app.api_server.run_patient_diagnostic", return_value=mock_diag):
            resp = self.client.post("/api/agent/generate-fix")
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertEqual(data["status"], "diagnostic_failed")
            self.assertIn("unreachable", data["error"])

    def test_generate_fix_bedrock_unavailable_handling(self):
        """Verify endpoint returns ai_unavailable when Bedrock credentials/service are unavailable."""
        self.client.post("/api/target/configure", json={
            "name": "SentinelOps Patient",
            "demo_url": "http://localhost:8001",
            "github_repo": "https://github.com/HITESHsai01/Patient",
            "branch": "main"
        })

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
            "root_cause": "matching[0] is accessed when no matching user exists",
            "suggested_fix": "Return a 404 response",
            "snippet": ["return matching[0]"],
            "source_code": "return matching[0]"
        }

        with patch("app.api_server.run_patient_diagnostic", return_value=mock_diag), \
             patch("app.api_server.inspect_patient_repository", return_value=mock_repo), \
             patch("app.fix_generator.boto3.client") as mock_boto:
            mock_client = MagicMock()
            mock_client.converse.side_effect = ClientError(
                {"Error": {"Code": "AccessDeniedException", "Message": "Bedrock access denied"}},
                "Converse"
            )
            mock_boto.return_value = mock_client

            resp = self.client.post("/api/agent/generate-fix")
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertEqual(data["status"], "ai_unavailable")
            self.assertIn("Bedrock access denied", data["error"])

    def test_generate_fix_success_response_structure(self):
        """Verify successful end-to-end fix generation returns structured proposal."""
        self.client.post("/api/target/configure", json={
            "name": "SentinelOps Patient",
            "demo_url": "http://localhost:8001",
            "github_repo": "https://github.com/HITESHsai01/Patient",
            "branch": "main"
        })

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
            "snippet": ["# SENTINELOPS_TEST_BUG", "return matching[0]"],
            "source_code": "matching = [u for u in USERS if u['id'] == user_id]\n# SENTINELOPS_TEST_BUG\nreturn matching[0]"
        }

        mock_llm_json = {
            "diagnosis": "IndexError in get_user_by_id due to empty matching list",
            "root_cause": "matching[0] is accessed when no matching user exists",
            "file": "app/routes.py",
            "proposed_fix": {
                "original_code": "return matching[0]",
                "replacement_code": "if not matching:\n        from fastapi import HTTPException\n        raise HTTPException(status_code=404, detail=\"User not found\")\n    return matching[0]"
            },
            "explanation": "Guards index access by raising a standard 404 when matching is empty, preserving existing behavior for valid user IDs.",
            "confidence": 0.96
        }

        mock_converse_resp = {
            "output": {
                "message": {
                    "content": [
                        {"text": json.dumps(mock_llm_json)}
                    ]
                }
            }
        }

        with patch("app.api_server.run_patient_diagnostic", return_value=mock_diag), \
             patch("app.api_server.inspect_patient_repository", return_value=mock_repo), \
             patch("app.fix_generator.boto3.client") as mock_boto:
            mock_client = MagicMock()
            mock_client.converse.return_value = mock_converse_resp
            mock_boto.return_value = mock_client

            resp = self.client.post("/api/agent/generate-fix")
            self.assertEqual(resp.status_code, 200)
            data = resp.json()

            # Structured schema assertions
            self.assertEqual(data["status"], "fix_proposed")
            self.assertEqual(data["target"], "SentinelOps Patient")
            self.assertEqual(data["file"], "app/routes.py")
            self.assertEqual(data["line"], 57)
            self.assertEqual(data["exception"], "IndexError")
            self.assertEqual(data["root_cause"], "matching[0] is accessed when no matching user exists")
            self.assertIn("proposed_fix", data)
            self.assertEqual(data["proposed_fix"]["original_code"], "return matching[0]")
            self.assertIn("HTTPException", data["proposed_fix"]["replacement_code"])
            self.assertEqual(data["confidence"], 0.96)
            self.assertIn("Guards index access", data["explanation"])


if __name__ == "__main__":
    unittest.main()
