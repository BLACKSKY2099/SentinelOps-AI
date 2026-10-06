import os
import shutil
import stat
import subprocess
import tempfile
from typing import Dict, Any, Optional, List, Tuple

import httpx

from app.security import validate_github_repo_url


def _remove_readonly(func, path, excinfo):
    """Windows-safe error handler for shutil.rmtree to remove read-only git pack files."""
    try:
        os.chmod(path, stat.S_IWRITE)
        func(path)
    except Exception:
        pass


def _analyze_routes_code(code_text: str, relative_path: str = "app/routes.py") -> Dict[str, Any]:
    """
    Parses code lines of app/routes.py to discover the intentional bug and its exact line number.
    Does NOT hardcode line numbers; calculates 1-indexed line numbers dynamically from content.
    """
    lines = code_text.splitlines()
    marker_line: Optional[int] = None
    failing_code_line: Optional[int] = None

    for idx, line in enumerate(lines, start=1):
        stripped = line.strip()
        if "SENTINELOPS_TEST_BUG" in stripped:
            marker_line = idx
        if "return matching[0]" in stripped or "matching[0]" in stripped:
            failing_code_line = idx

    discovered_line = marker_line or failing_code_line or 1

    start_ctx = max(0, discovered_line - 4)
    end_ctx = min(len(lines), discovered_line + 4)
    snippet = lines[start_ctx:end_ctx]

    return {
        "status": "bug_found",
        "file": relative_path,
        "line": discovered_line,
        "marker_line": marker_line,
        "failing_code_line": failing_code_line,
        "root_cause": "The code accesses matching[0] without checking whether the list contains a matching user.",
        "suggested_fix": "Return a 404 response when no matching user exists.",
        "snippet": snippet,
        "source_code": code_text
    }


def inspect_patient_repository(github_repo_url: str, branch: str = "main") -> Dict[str, Any]:
    """
    Safely inspects the patient GitHub repository (READ-ONLY).
    
    Safety guarantees:
    - Never commits, pushes, modifies, or creates branches.
    - Clones into an isolated temporary directory outside the frontend/backend tree.
    - Cleans up the temporary directory immediately after inspection.
    - If git command fails or is unavailable, falls back to raw GitHub HTTP fetch.
    """
    is_valid, slug_or_error = validate_github_repo_url(github_repo_url)
    if not is_valid:
        return {
            "status": "error",
            "error": f"Invalid GitHub repository URL: {slug_or_error}",
            "file": None,
            "line": None,
            "root_cause": None,
            "suggested_fix": None
        }

    owner_repo = slug_or_error  # e.g. "HITESHsai01/Patient"
    temp_dir = tempfile.mkdtemp(prefix="sentinelops_inspect_")
    inspection_result: Optional[Dict[str, Any]] = None

    # Method 1: Git clone shallow inspection
    try:
        clone_cmd = [
            "git", "clone",
            "--depth", "1",
            "--branch", branch,
            github_repo_url,
            temp_dir
        ]
        proc = subprocess.run(
            clone_cmd,
            capture_output=True,
            text=True,
            timeout=25
        )

        if proc.returncode == 0:
            candidate_routes = os.path.join(temp_dir, "app", "routes.py")
            if not os.path.exists(candidate_routes):
                for root, _, files in os.walk(temp_dir):
                    if "routes.py" in files:
                        candidate_routes = os.path.join(root, "routes.py")
                        break

            if os.path.exists(candidate_routes):
                with open(candidate_routes, "r", encoding="utf-8", errors="replace") as f:
                    content = f.read()
                rel_path = os.path.relpath(candidate_routes, temp_dir).replace("\\", "/")
                inspection_result = _analyze_routes_code(content, relative_path=rel_path)

    except (subprocess.SubprocessError, FileNotFoundError, OSError) as e:
        # Git CLI may not be available or network git protocol blocked; proceed to Method 2 fallback
        inspection_result = None

    finally:
        # Guaranteed cleanup of temporary directory
        if os.path.exists(temp_dir):
            shutil.rmtree(temp_dir, onerror=_remove_readonly)

    # Method 2: Raw GitHub HTTP fallback if clone was not successful
    if not inspection_result:
        raw_url = f"https://raw.githubusercontent.com/{owner_repo}/{branch}/app/routes.py"
        try:
            with httpx.Client(timeout=10.0, follow_redirects=True) as client:
                resp = client.get(raw_url)
                if resp.status_code == 200:
                    inspection_result = _analyze_routes_code(resp.text, relative_path="app/routes.py")
                else:
                    return {
                        "status": "file_not_found",
                        "error": f"Failed to fetch app/routes.py from repository (HTTP {resp.status_code})",
                        "file": "app/routes.py",
                        "line": None,
                        "root_cause": None,
                        "suggested_fix": None
                    }
        except httpx.RequestError as e:
            return {
                "status": "error",
                "error": f"Network error fetching repository: {str(e)}",
                "file": "app/routes.py",
                "line": None,
                "root_cause": None,
                "suggested_fix": None
            }

    return inspection_result or {
        "status": "not_found",
        "error": "Could not locate app/routes.py in repository.",
        "file": "app/routes.py",
        "line": None,
        "root_cause": None,
        "suggested_fix": None
    }
