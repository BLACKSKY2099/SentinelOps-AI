import json
import os
import re
from typing import Dict, Any, Optional

import boto3
from botocore.exceptions import BotoCoreError, ClientError

# Bedrock configuration reusing existing repository parameters
DEFAULT_BEDROCK_MODEL_ID = "us.meta.llama3-3-70b-instruct-v1:0"
DEFAULT_AWS_REGION = "us-east-1"

BEDROCK_SYSTEM_PROMPT = """You are a software remediation engineer.
Analyze the supplied runtime error, diagnosis, and source code.
Produce the smallest safe code change that fixes the diagnosed issue.
Do not redesign unrelated code.
Do not change APIs unnecessarily.
Do not introduce dependencies unless absolutely required.
Preserve existing behavior for valid requests.
Handle the failing edge case correctly.

You must return a valid JSON object matching this schema:
{
  "diagnosis": "Summary of the diagnosed issue",
  "root_cause": "Specific explanation of why the defect occurs",
  "file": "app/routes.py",
  "proposed_fix": {
    "original_code": "return matching[0]",
    "replacement_code": "if not matching:\\n        from fastapi import HTTPException\\n        raise HTTPException(status_code=404, detail=\\"User not found\\")\\n    return matching[0]"
  },
  "explanation": "Clear technical explanation of why this fix is safe, minimal, and correct",
  "confidence": 0.95
}

Return ONLY the raw JSON object. Do not include markdown explanation outside the JSON."""


def sanitize_error_message(err_str: str, explicit_token: Optional[str] = None) -> str:
    """
    Sanitizes error messages to prevent accidental leakage of AWS access keys,
    secret keys, session tokens, or personal access tokens.
    """
    if not err_str:
        return "Unknown error"
    sanitized = str(err_str)
    if explicit_token and explicit_token in sanitized:
        sanitized = sanitized.replace(explicit_token, "[REDACTED_GH_TOKEN]")
    # Redact Authorization: Bearer tokens
    sanitized = re.sub(r'(Bearer\s+)[^\s"\'<>]+', r'\1[REDACTED_TOKEN]', sanitized, flags=re.IGNORECASE)
    # Redact AWS access key IDs (AKIA..., ASIA...)
    sanitized = re.sub(r'(?:AKIA|ASIA)[0-9A-Z]{16}', '[REDACTED_AWS_KEY]', sanitized)
    # Redact GitHub tokens (ghp_..., github_pat_...)
    sanitized = re.sub(r'ghp_[0-9a-zA-Z_]+', '[REDACTED_GH_TOKEN]', sanitized)
    sanitized = re.sub(r'github_pat_[0-9a-zA-Z_]+', '[REDACTED_GH_PAT]', sanitized)
    # Redact AWS secret key patterns (common 40 char base64 strings after secret key labels)
    sanitized = re.sub(r'(aws_secret_access_key\s*=\s*)[^\s]+', r'\1[REDACTED_SECRET]', sanitized, flags=re.IGNORECASE)
    return sanitized


def parse_bedrock_json_response(raw_text: str) -> Dict[str, Any]:
    """
    Robustly parses the JSON payload returned by Bedrock, stripping markdown
    code fences if present.
    """
    text = raw_text.strip()
    if not text:
        raise ValueError("Bedrock returned an empty response.")

    # 1. Try direct JSON parsing
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # 2. Try extracting from markdown code block ```json ... ```
    fence_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fence_match:
        try:
            return json.loads(fence_match.group(1))
        except json.JSONDecodeError:
            pass

    # 3. Try finding outermost { ... }
    brace_match = re.search(r"(\{.*\})", text, re.DOTALL)
    if brace_match:
        try:
            return json.loads(brace_match.group(1))
        except json.JSONDecodeError:
            pass

    raise ValueError(f"Unable to parse structured JSON from Bedrock output: {text[:200]}...")


def get_bedrock_client(region_name: Optional[str] = None):
    """
    Creates a boto3 bedrock-runtime client using existing environment/IAM credentials.
    Does not invent or hardcode credentials.
    """
    region = (region_name or os.getenv("AWS_REGION") or DEFAULT_AWS_REGION).strip()
    return boto3.client("bedrock-runtime", region_name=region)


def generate_bedrock_fix(
    context: Dict[str, Any],
    region_name: Optional[str] = None,
    model_id: Optional[str] = None,
    bedrock_client: Optional[Any] = None
) -> Dict[str, Any]:
    """
    Invokes Amazon Bedrock using the Converse API with Llama 3.3 70B Instruct
    to propose a minimal safe code fix for the diagnosed defect.

    Guarantees:
    - READ-ONLY: Never writes to repository, never executes code.
    - Graceful error handling: Returns status='ai_unavailable' if Bedrock is unreachable or unconfigured.
    - Returns structured JSON proposal adhering to schema.
    """
    target_name = context.get("target", "SentinelOps Patient")
    file_path = context.get("file", "app/routes.py")
    line_number = context.get("line", 57)
    exception_type = context.get("exception", "IndexError")
    error_message = context.get("error_message", "list index out of range")
    root_cause = context.get("root_cause", "matching[0] is accessed when no matching user exists")
    suggested_fix = context.get("suggested_fix", "Return a 404 response when no matching user exists.")
    source_code = context.get("source_code") or context.get("code_snippet") or "return matching[0]"

    if isinstance(source_code, list):
        source_code_str = "\n".join(source_code)
    else:
        source_code_str = str(source_code)

    effective_model_id = (model_id or os.getenv("BEDROCK_MODEL_ID") or DEFAULT_BEDROCK_MODEL_ID).strip()
    effective_region = (region_name or os.getenv("AWS_REGION") or DEFAULT_AWS_REGION).strip()

    user_prompt = f"""Target Application: {target_name}
Failing Diagnostic Test: {context.get('endpoint', '/api/user/999')}
Observed Exception: {exception_type}
Error Message: {error_message}

Repository Diagnostic:
- Target File: {file_path}
- Discovered Line: {line_number}
- Diagnosed Root Cause: {root_cause}
- Remediation Direction: {suggested_fix}

Relevant Source Code ({file_path}):
```python
{source_code_str}
```

Propose the smallest safe code change that fixes this diagnosed issue.
Return ONLY structured JSON conforming to the requested schema."""

    messages = [
        {
            "role": "user",
            "content": [{"text": user_prompt}]
        }
    ]

    try:
        client = bedrock_client or get_bedrock_client(region_name=effective_region)
        response = client.converse(
            modelId=effective_model_id,
            messages=messages,
            system=[{"text": BEDROCK_SYSTEM_PROMPT}],
            inferenceConfig={
                "maxTokens": 2048,
                "temperature": 0.1
            }
        )
    except (BotoCoreError, ClientError, Exception) as e:
        clean_err = sanitize_error_message(str(e))
        return {
            "status": "ai_unavailable",
            "error": f"Amazon Bedrock inference error: {clean_err}"
        }

    try:
        output_msg = response.get("output", {}).get("message", {})
        content_blocks = output_msg.get("content", [])
        raw_text = ""
        for block in content_blocks:
            if "text" in block:
                raw_text += block["text"]

        parsed_data = parse_bedrock_json_response(raw_text)

        # Normalize proposed_fix block
        proposed_fix = parsed_data.get("proposed_fix")
        if isinstance(proposed_fix, dict):
            orig_code = proposed_fix.get("original_code", "return matching[0]")
            repl_code = proposed_fix.get("replacement_code", "")
        else:
            orig_code = parsed_data.get("original_code", "return matching[0]")
            repl_code = parsed_data.get("replacement_code", "")

        # Normalize confidence
        raw_conf = parsed_data.get("confidence", 0.95)
        try:
            confidence = float(raw_conf)
            if confidence > 1.0:
                confidence = confidence / 100.0
        except (ValueError, TypeError):
            confidence = 0.95

        return {
            "status": "fix_proposed",
            "target": target_name,
            "file": parsed_data.get("file") or file_path,
            "line": line_number,
            "exception": exception_type,
            "root_cause": parsed_data.get("root_cause") or root_cause,
            "proposed_fix": {
                "original_code": orig_code,
                "replacement_code": repl_code
            },
            "explanation": parsed_data.get("explanation") or "Minimal safe check to handle empty matching list without raising IndexError.",
            "confidence": round(confidence, 2)
        }

    except Exception as parse_err:
        return {
            "status": "ai_unavailable",
            "error": f"Failed to parse structured AI fix from Bedrock response: {sanitize_error_message(str(parse_err))}"
        }
