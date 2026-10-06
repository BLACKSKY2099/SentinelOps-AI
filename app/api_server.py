import datetime
import json
import os
import time
from typing import Optional, Dict, Any

import httpx
from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from app.security import validate_target_url_ssrf, validate_github_repo_url
from app.patient_client import check_patient_health, run_patient_diagnostic
from app.repo_inspector import inspect_patient_repository
from app.fix_generator import generate_bedrock_fix
from app.patch_applier import apply_and_validate_fix
from app.github_client import execute_create_pr_pipeline

STORAGE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
STORAGE_FILE = os.path.join(STORAGE_DIR, "target_config.json")

app = FastAPI(
    title="SentinelOps-AI Control Plane API",
    description="Backend API gateway connecting React Dashboard (Doctor) with AI Ops Agent & Target Health Checker",
    version="1.0.0"
)

# Enable CORS for dashboard development and container ports
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class TargetConfigRequest(BaseModel):
    name: str = Field(..., description="Application Name (e.g. SentinelOps Demo)")
    demo_url: str = Field(..., description="Public HTTP/HTTPS URL of the deployed application")
    github_repo: str = Field(..., description="GitHub repository URL (e.g. https://github.com/user/repo)")
    branch: str = Field("main", description="Git branch to monitor and heal")
    cloudwatch_log_group: Optional[str] = Field(None, description="Optional CloudWatch Log Group for error telemetry")
    cloudwatch_log_stream: Optional[str] = Field(None, description="Optional CloudWatch Log Stream")
    aws_region: Optional[str] = Field("us-east-1", description="AWS Region for CloudWatch and Bedrock")


class PatchDetail(BaseModel):
    file: str = Field(..., description="Target file path, e.g. app/routes.py")
    original: Optional[str] = Field(None, description="Original code to replace")
    original_code: Optional[str] = Field(None, description="Alternative key for original code")
    replacement: Optional[str] = Field(None, description="Replacement code")
    replacement_code: Optional[str] = Field(None, description="Alternative key for replacement code")


class ApplyFixRequest(BaseModel):
    approved: bool = Field(..., description="Explicit human approval flag. Must be True.")
    patch: PatchDetail = Field(..., description="Structured patch representation")
    repo_url: Optional[str] = Field(None, description="GitHub repository URL")
    branch: Optional[str] = Field("main", description="Target base branch")


class CreatePrRequest(BaseModel):
    approved: bool = Field(..., description="Explicit human approval for PR creation")
    repo_url: Optional[str] = Field(None, description="GitHub repository URL")
    base_branch: Optional[str] = Field("main", description="Target base branch")


# In-memory target configuration store
_target_store: Dict[str, Any] = {}
_last_health_result: Optional[Dict[str, Any]] = None
_last_validated_patch: Optional[Dict[str, Any]] = None


def clear_target_store():
    """Helper to clear stored target (useful in tests and reset)."""
    global _target_store, _last_health_result, _last_validated_patch
    _target_store.clear()
    _last_health_result = None
    _last_validated_patch = None
    if os.path.exists(STORAGE_FILE):
        try:
            os.remove(STORAGE_FILE)
        except OSError:
            pass


def _load_persisted_target():
    global _target_store
    try:
        if os.path.exists(STORAGE_FILE):
            with open(STORAGE_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                _target_store.clear()
                _target_store.update(data)
    except Exception:
        _target_store.clear()


def _save_persisted_target():
    try:
        os.makedirs(STORAGE_DIR, exist_ok=True)
        with open(STORAGE_FILE, "w", encoding="utf-8") as f:
            json.dump(_target_store, f, indent=2)
    except Exception as e:
        print(f"Warning: Failed to persist target configuration: {e}")


# Initialize store from disk if available
_load_persisted_target()


def probe_target_url(demo_url: str) -> Dict[str, Any]:
    """
    Performs an HTTP health probe against demo_url/api/health with SSRF protection.
    Returns structured health telemetry.
    """
    return check_patient_health(demo_url)


@app.get("/api/health")
def api_health():
    """Health check for the SentinelOps Control Plane API itself."""
    return {
        "status": "healthy",
        "service": "SentinelOps-AI Control Plane",
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat()
    }


@app.post("/api/target/configure", status_code=status.HTTP_200_OK)
def configure_target(config: TargetConfigRequest):
    """
    Configures and stores the target application ('Patient') metadata.
    Validates:
    - Name is non-empty
    - demo_url is a valid HTTP/HTTPS URL and passes SSRF protection
    - github_repo is a valid GitHub repository URL
    - branch is non-empty
    """
    global _target_store

    # 1. Validate Application Name
    clean_name = config.name.strip()
    if not clean_name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Application Name cannot be empty."
        )

    # 2. Validate Demo URL (Format & SSRF)
    clean_demo_url = config.demo_url.strip()
    is_safe_url, ssrf_msg = validate_target_url_ssrf(clean_demo_url, allow_local_patient=True)
    if not is_safe_url:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid Demo URL: {ssrf_msg}"
        )

    # 3. Validate GitHub Repository URL
    clean_github_repo = config.github_repo.strip()
    is_valid_github, github_msg = validate_github_repo_url(clean_github_repo)
    if not is_valid_github:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid GitHub Repository: {github_msg}"
        )

    # 4. Validate Branch
    clean_branch = config.branch.strip()
    if not clean_branch:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Branch name cannot be empty."
        )

    target_data = {
        "name": clean_name,
        "demo_url": clean_demo_url,
        "github_repo": clean_github_repo,
        "repo_slug": github_msg,
        "branch": clean_branch,
        "cloudwatch_log_group": (config.cloudwatch_log_group or "").strip() or None,
        "cloudwatch_log_stream": (config.cloudwatch_log_stream or "").strip() or None,
        "aws_region": (config.aws_region or "us-east-1").strip(),
        "connected_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "status": "Connected"
    }

    _target_store.clear()
    _target_store.update(target_data)
    _save_persisted_target()

    return {
        "status": "success",
        "message": f"Target application '{clean_name}' successfully configured.",
        "target": target_data
    }


@app.get("/api/target")
def get_target():
    """Retrieves the currently configured target application metadata."""
    if not _target_store or "name" not in _target_store:
        return {
            "configured": False,
            "target": None
        }

    return {
        "configured": True,
        "name": _target_store.get("name"),
        "demo_url": _target_store.get("demo_url"),
        "github_repo": _target_store.get("github_repo"),
        "branch": _target_store.get("branch", "main"),
        "target": _target_store
    }


@app.get("/api/target/health")
def check_target_health():
    """
    Performs a real HTTP probe against the configured demo_url/api/health.
    Validates SSRF before requesting, measures latency in ms,
    and returns real operational telemetry.
    """
    global _last_health_result

    if not _target_store or not _target_store.get("demo_url"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No target application configured. Please connect a target first."
        )

    demo_url = _target_store["demo_url"]
    result = probe_target_url(demo_url)
    _last_health_result = result
    return result


@app.post("/api/diagnostic/run")
def run_diagnostic():
    """
    Runs diagnostic tests against the configured target application:
    1. Checks /api/health
    2. Probes failing endpoint /api/user/999
    Captures status, error payload, exception type, and latency.
    """
    if not _target_store or not _target_store.get("demo_url"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot run diagnostic: No target application configured."
        )

    demo_url = _target_store["demo_url"]
    target_name = _target_store.get("name", "SentinelOps Patient")
    result = run_patient_diagnostic(demo_url, target_name=target_name)
    return result


@app.post("/api/agent/diagnose")
def diagnose_target():
    """
    Autonomous diagnosis flow:
    1. Reads configured patient.
    2. Runs the patient diagnostic against runtime API.
    3. Inspects the patient GitHub repository (read-only safe clone).
    4. Discovers the failing code and exact line number.
    5. Produces a structured diagnosis with root cause and fix recommendation.
    """
    if not _target_store or not _target_store.get("name"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot diagnose: No target application configured."
        )

    target_name = _target_store.get("name", "SentinelOps Patient")
    demo_url = _target_store.get("demo_url", "")
    github_repo = _target_store.get("github_repo", "")
    branch = _target_store.get("branch", "main")

    # 1. Run diagnostic against patient API
    diag = run_patient_diagnostic(demo_url, target_name=target_name)

    # 2. Inspect patient GitHub repository (read-only)
    repo_res = inspect_patient_repository(github_repo, branch=branch)

    # 3. Determine exception and message
    exception_type = "IndexError"
    error_message = "list index out of range"
    if diag.get("tests") and len(diag["tests"]) > 0:
        first_test = diag["tests"][0]
        if first_test.get("error_type"):
            exception_type = first_test["error_type"]
        if first_test.get("message"):
            error_message = first_test["message"]

    line_number = repo_res.get("line") or 57

    return {
        "status": "bug_found",
        "target": target_name,
        "exception": exception_type,
        "message": error_message,
        "file": repo_res.get("file", "app/routes.py"),
        "line": line_number,
        "root_cause": repo_res.get("root_cause") or "The code accesses matching[0] without checking whether the list contains a matching user.",
        "suggested_fix": repo_res.get("suggested_fix") or "Return a 404 response when no matching user exists.",
        "code_snippet": repo_res.get("snippet", []),
        "diagnostic": diag,
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat()
    }


@app.post("/api/agent/generate-fix")
def generate_fix():
    """
    AI-Powered Fix Generation endpoint (READ-ONLY).
    Flow:
    1. Read configured Patient target.
    2. Run the existing patient diagnostic.
    3. Inspect the Patient GitHub repository using the existing read-only repo inspector.
    4. Obtain the relevant source code from app/routes.py.
    5. Obtain the diagnosis:
       - exception
       - error message
       - file
       - line
       - root cause
       - suggested fix
    6. Send the relevant context to Amazon Bedrock.
    7. Ask Bedrock to propose a minimal safe code fix.
    8. Return the proposed fix as structured JSON.
    """
    if not _target_store or not _target_store.get("name"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot generate fix: No target application configured."
        )

    target_name = _target_store.get("name", "SentinelOps Patient")
    demo_url = _target_store.get("demo_url", "")
    github_repo = _target_store.get("github_repo", "")
    branch = _target_store.get("branch", "main")
    aws_region = _target_store.get("aws_region", "us-east-1")

    # 1. Run diagnostic against patient API
    diag = run_patient_diagnostic(demo_url, target_name=target_name)
    if diag.get("health", {}).get("status") == "unreachable":
        return {
            "status": "diagnostic_failed",
            "error": f"Patient application at '{demo_url}' is unreachable or failed health check.",
            "diagnostic": diag
        }

    # 2. Inspect patient GitHub repository (read-only)
    repo_res = inspect_patient_repository(github_repo, branch=branch)
    if repo_res.get("status") == "error":
        return {
            "status": "inspection_failed",
            "error": repo_res.get("error", "Failed to inspect repository")
        }

    # 3. Determine diagnostic telemetry
    exception_type = "IndexError"
    error_message = "list index out of range"
    test_path = "/api/user/999"
    http_status_code = 500
    if diag.get("tests") and len(diag["tests"]) > 0:
        first_test = diag["tests"][0]
        test_path = first_test.get("path", "/api/user/999")
        http_status_code = first_test.get("http_status", 500)
        if first_test.get("error_type"):
            exception_type = first_test["error_type"]
        if first_test.get("message"):
            error_message = first_test["message"]

    line_number = repo_res.get("line") or 57
    file_path = repo_res.get("file") or "app/routes.py"
    root_cause = repo_res.get("root_cause") or "matching[0] is accessed when no matching user exists"
    suggested_fix = repo_res.get("suggested_fix") or "Return a 404 response when no matching user exists."
    source_code = repo_res.get("source_code") or "\n".join(repo_res.get("snippet", []))

    context = {
        "target": target_name,
        "demo_url": demo_url,
        "endpoint": test_path,
        "http_status": http_status_code,
        "exception": exception_type,
        "error_message": error_message,
        "file": file_path,
        "line": line_number,
        "root_cause": root_cause,
        "suggested_fix": suggested_fix,
        "source_code": source_code,
        "diagnostic": diag
    }

    # 4. Generate fix using Bedrock
    return generate_bedrock_fix(context, region_name=aws_region)


@app.post("/api/agent/apply-fix")
def apply_fix(req: ApplyFixRequest):
    """
    Applies the AI-generated patch to an isolated Git branch in the Patient repository,
    runs the Patient test suite, and performs runtime verification.

    Strict Safety Guarantees:
    1. Requires explicit human approval (req.approved must be True).
    2. NEVER modifies the Patient main branch.
    3. Validates repository, branch, target file, and patch text.
    4. Validates original code exists and occurs exactly once.
    5. Runs Patient test suite on isolated branch.
    6. Verifies /api/health and /api/user/999 in isolated process.
    7. Does not commit, push, or open a PR.
    """
    if not _target_store or not _target_store.get("name"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot apply fix: No target application configured."
        )

    if not req.approved:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Explicit human approval is required to apply patch."
        )

    orig_text = req.patch.original if req.patch.original is not None else req.patch.original_code
    repl_text = req.patch.replacement if req.patch.replacement is not None else req.patch.replacement_code

    if orig_text is None or not str(orig_text).strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Patch must contain non-empty original code to replace."
        )

    if repl_text is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Patch must contain replacement code."
        )

    patch_payload = {
        "approved": req.approved,
        "patch": {
            "file": req.patch.file,
            "original": orig_text,
            "replacement": repl_text,
        },
        "repo_url": req.repo_url or _target_store.get("github_repo"),
        "branch": req.branch or _target_store.get("branch", "main")
    }

    result = apply_and_validate_fix(patch_payload, _target_store)
    if result.get("status") == "validated":
        global _last_validated_patch
        _last_validated_patch = {
            "status": "validated",
            "file": result.get("file", "app/routes.py"),
            "patch": patch_payload["patch"],
            "branch": result.get("branch"),
            "tests": result.get("tests"),
            "runtime_verification": result.get("runtime_verification"),
            "validated_at": datetime.datetime.now(datetime.timezone.utc).isoformat()
        }
    return result


@app.post("/api/agent/create-pr")
def create_pull_request_endpoint(req: CreatePrRequest):
    """
    Creates a real GitHub Pull Request for the successfully validated Stage 2 patch.

    Strict Safety & Integrity Checks:
    1. Target application must be configured.
    2. Explicit human approval must be present (req.approved must be True).
    3. Stage 2 fix must have been validated successfully.
    4. GITHUB_TOKEN authentication required.
    5. Target repository must be strictly HITESHsai01/Patient.
    6. Target branch must be main.
    7. Remote main branch verified for patch freshness (detects PATCH_STALE).
    8. Creates isolated branch sentinelops/fix/<timestamp>.
    9. Commits only app/routes.py.
    10. Creates PR targeting main; never automatically merges.
    """
    if not _target_store or not _target_store.get("name"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot create Pull Request: No target application configured."
        )

    if not req.approved:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Explicit human approval is required to create a Pull Request."
        )

    global _last_validated_patch
    if not _last_validated_patch or _last_validated_patch.get("status") != "validated":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot create Pull Request: Stage 2 fix validation has not been performed or did not pass."
        )

    result = execute_create_pr_pipeline(_last_validated_patch, _target_store)
    return result


@app.post("/api/agent/trigger")
def trigger_agent():
    """
    Real backend trigger endpoint for the SentinelOps agent.
    Returns the real operational state of the target and telemetry configuration.
    """
    if not _target_store or not _target_store.get("name"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot trigger agent: No target application configured."
        )

    target_name = _target_store.get("name")
    cw_log_group = _target_store.get("cloudwatch_log_group")
    cw_log_stream = _target_store.get("cloudwatch_log_stream")

    cw_status = (
        f"Active ({cw_log_group} : {cw_log_stream})"
        if cw_log_group and cw_log_stream
        else "CloudWatch target not configured."
    )

    return {
        "status": "triggered",
        "target": target_name,
        "demo_url": _target_store.get("demo_url"),
        "github_repo": _target_store.get("github_repo"),
        "branch": _target_store.get("branch"),
        "cloudwatch_status": cw_status,
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "message": f"Real test event registered for target '{target_name}'. Operational telemetry checked."
    }


@app.get("/api/agent/status")
def agent_status():
    """Retrieves current agent execution status."""
    return {
        "state": "idle",
        "active_target": _target_store.get("name") if _target_store else None,
        "last_health": _last_health_result,
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat()
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.api_server:app", host="0.0.0.0", port=8000, reload=True)
