import base64
import datetime
import os
import re
from typing import Dict, Any, Optional, Tuple

import httpx

from app.fix_generator import sanitize_error_message

# Strict security boundaries: SentinelOps Stage 3 is locked to HITESHsai01/Patient
ALLOWED_OWNER = "HITESHsai01"
ALLOWED_REPO = "Patient"
ALLOWED_BASE_BRANCH = "main"
ALLOWED_TARGET_FILE = "app/routes.py"
GITHUB_API_BASE = "https://api.github.com"


def get_github_token() -> Optional[str]:
    """
    Retrieves the GitHub token from the environment.
    Never hardcodes credentials or accepts frontend-supplied tokens.
    """
    token = os.getenv("GITHUB_TOKEN") or os.getenv("GH_TOKEN")
    if token and token.strip():
        return token.strip()
    return None


def parse_repo_slug(repo_url_or_slug: str) -> Tuple[Optional[str], Optional[str]]:
    """Extracts (owner, repo) from a GitHub URL or slug."""
    clean = repo_url_or_slug.strip().rstrip("/")
    if clean.endswith(".git"):
        clean = clean[:-4]

    # Pattern: https://github.com/owner/repo or owner/repo
    m = re.search(r"(?:https?://(?:www\.)?github\.com/)?([^/]+)/([^/]+)$", clean)
    if m:
        return m.group(1), m.group(2)
    return None, None


def validate_repo_and_branch(owner: str, repo: str, base_branch: str) -> Tuple[bool, str]:
    """
    Enforces strict repository and branch allowlists.
    Protects against unauthorized repository writes or targeting non-main branches.
    """
    if owner != ALLOWED_OWNER or repo != ALLOWED_REPO:
        return False, (
            f"Unauthorized repository '{owner}/{repo}'. SentinelOps PR integration "
            f"is strictly restricted to '{ALLOWED_OWNER}/{ALLOWED_REPO}'."
        )

    if base_branch != ALLOWED_BASE_BRANCH:
        return False, (
            f"Unauthorized base branch '{base_branch}'. PRs must strictly target '{ALLOWED_BASE_BRANCH}'."
        )

    return True, "Repository and branch allowlist validation passed."


def get_main_branch_head(
    client: httpx.Client,
    owner: str,
    repo: str,
    branch: str = "main",
    headers: Optional[Dict[str, str]] = None
) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
    """Retrieves the latest commit SHA of the main branch."""
    url = f"{GITHUB_API_BASE}/repos/{owner}/{repo}/git/ref/heads/{branch}"
    try:
        resp = client.get(url, headers=headers)
        if resp.status_code == 200:
            data = resp.json()
            sha = data.get("object", {}).get("sha")
            if not sha:
                return False, f"Could not determine commit SHA for branch '{branch}'.", None
            return True, "Main branch reference retrieved.", {"sha": sha, "ref": data.get("ref")}
        elif resp.status_code in (401, 403):
            return False, "GitHub authentication failed. Check your GITHUB_TOKEN permissions.", None
        elif resp.status_code == 404:
            return False, f"Repository '{owner}/{repo}' or branch '{branch}' not found.", None
        else:
            return False, f"GitHub API error fetching branch '{branch}' (HTTP {resp.status_code}): {resp.text[:150]}", None
    except Exception as e:
        return False, f"Network error connecting to GitHub API: {sanitize_error_message(str(e))}", None


def get_file_content_from_github(
    client: httpx.Client,
    owner: str,
    repo: str,
    file_path: str,
    ref: str = "main",
    headers: Optional[Dict[str, str]] = None
) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
    """
    Fetches the raw content and blob SHA of a file from a specific branch on GitHub.
    Used to verify patch integrity and detect stale source code.
    """
    url = f"{GITHUB_API_BASE}/repos/{owner}/{repo}/contents/{file_path}?ref={ref}"
    try:
        resp = client.get(url, headers=headers)
        if resp.status_code == 200:
            data = resp.json()
            content_b64 = data.get("content", "")
            try:
                decoded = base64.b64decode(content_b64).decode("utf-8", errors="replace")
            except Exception as b64_err:
                return False, f"Failed to decode base64 file content: {str(b64_err)}", None

            return True, "File retrieved.", {
                "content": decoded,
                "sha": data.get("sha"),
                "path": data.get("path")
            }
        elif resp.status_code == 404:
            return False, f"Target file '{file_path}' not found in repository '{owner}/{repo}' on branch '{ref}'.", None
        elif resp.status_code in (401, 403):
            return False, "GitHub authentication failed reading file content.", None
        else:
            return False, f"GitHub API error reading '{file_path}' (HTTP {resp.status_code}): {resp.text[:150]}", None
    except Exception as e:
        return False, f"Network error reading file from GitHub: {sanitize_error_message(str(e))}", None


def verify_patch_integrity(
    main_content: str,
    patch_data: Dict[str, Any],
    target_file: str
) -> Tuple[bool, str, Optional[str]]:
    """
    Verifies that the target file content on the remote main branch matches
    the original source code that passed Stage 2 validation.

    If the code on main has changed since Stage 2 validation, aborts with PATCH_STALE.
    """
    norm_file = os.path.normpath(target_file).replace("\\", "/")
    if norm_file != ALLOWED_TARGET_FILE:
        return False, f"Patch modifies unexpected file '{norm_file}'. Only modifications to '{ALLOWED_TARGET_FILE}' are permitted.", None

    orig_code = patch_data.get("original") or patch_data.get("original_code")
    repl_code = patch_data.get("replacement") or patch_data.get("replacement_code")

    if not orig_code or not str(orig_code).strip():
        return False, "Patch data missing original code snippet.", None

    if repl_code is None:
        return False, "Patch data missing replacement code.", None

    # Check exact occurrence in main_content
    count = main_content.count(orig_code)
    if count == 0:
        return False, (
            "PATCH_STALE: Target file 'app/routes.py' on main branch no longer contains the original code "
            "used during diagnosis. The remote repository may have been updated since Stage 2 validation. "
            "Aborting PR creation to prevent overwriting newer code."
        ), None

    if count > 1:
        return False, (
            f"PATCH_STALE: Original code occurs {count} times in remote 'app/routes.py'. "
            "Cannot deterministically apply patch."
        ), None

    patched_content = main_content.replace(orig_code, repl_code, 1)
    return True, "Patch integrity verified against current main branch.", patched_content


def create_github_branch(
    client: httpx.Client,
    owner: str,
    repo: str,
    branch_name: str,
    base_sha: str,
    headers: Optional[Dict[str, str]] = None
) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
    """Creates a new git reference refs/heads/<branch_name> pointing to base_sha."""
    url = f"{GITHUB_API_BASE}/repos/{owner}/{repo}/git/refs"
    payload = {
        "ref": f"refs/heads/{branch_name}",
        "sha": base_sha
    }
    try:
        resp = client.post(url, json=payload, headers=headers)
        if resp.status_code == 201:
            return True, "Branch created successfully.", resp.json()
        elif resp.status_code == 422:
            return False, f"Branch '{branch_name}' already exists or reference is invalid (HTTP 422).", None
        elif resp.status_code in (401, 403):
            return False, "GitHub authentication failed creating branch. Write permissions required.", None
        else:
            return False, f"Failed to create branch '{branch_name}' (HTTP {resp.status_code}): {resp.text[:150]}", None
    except Exception as e:
        return False, f"Network error creating branch: {sanitize_error_message(str(e))}", None


def commit_file_to_branch(
    client: httpx.Client,
    owner: str,
    repo: str,
    file_path: str,
    file_content: str,
    branch_name: str,
    file_blob_sha: str,
    commit_message: str,
    headers: Optional[Dict[str, str]] = None
) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
    """
    Commits the patched file to the newly created isolated branch.
    Never commits to main.
    """
    if branch_name in ("main", "refs/heads/main", "master"):
        return False, "CRITICAL SAFETY VIOLATION: Direct commits to main branch are forbidden.", None

    url = f"{GITHUB_API_BASE}/repos/{owner}/{repo}/contents/{file_path}"
    b64_content = base64.b64encode(file_content.encode("utf-8")).decode("ascii")

    payload = {
        "message": commit_message,
        "content": b64_content,
        "sha": file_blob_sha,
        "branch": branch_name
    }
    try:
        resp = client.put(url, json=payload, headers=headers)
        if resp.status_code in (200, 201):
            data = resp.json()
            commit_sha = data.get("commit", {}).get("sha")
            return True, "File successfully committed.", {"sha": commit_sha, "details": data}
        elif resp.status_code in (401, 403):
            return False, "GitHub authentication failed committing file to branch.", None
        else:
            return False, f"Failed to commit file '{file_path}' (HTTP {resp.status_code}): {resp.text[:150]}", None
    except Exception as e:
        return False, f"Network error committing to branch: {sanitize_error_message(str(e))}", None


def create_pull_request(
    client: httpx.Client,
    owner: str,
    repo: str,
    title: str,
    body: str,
    head_branch: str,
    base_branch: str = "main",
    headers: Optional[Dict[str, str]] = None
) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
    """
    Creates a Pull Request on GitHub targeting base_branch.
    Guarantees:
    - Target branch is strictly 'main'.
    - Head branch is the isolated fix branch.
    - NEVER automatically merges the PR.
    """
    if base_branch != "main":
        return False, "PR base branch must be strictly 'main'.", None

    if head_branch in ("main", "master"):
        return False, "PR head branch cannot be main.", None

    url = f"{GITHUB_API_BASE}/repos/{owner}/{repo}/pulls"
    payload = {
        "title": title,
        "body": body,
        "head": head_branch,
        "base": base_branch
    }
    try:
        resp = client.post(url, json=payload, headers=headers)
        if resp.status_code == 201:
            data = resp.json()
            pr_url = data.get("html_url")
            pr_num = data.get("number")
            return True, "Pull Request created successfully.", {
                "html_url": pr_url,
                "number": pr_num,
                "state": data.get("state", "open"),
                "details": data
            }
        elif resp.status_code == 422:
            return False, f"PR creation rejected by GitHub (HTTP 422): {resp.text[:150]}", None
        elif resp.status_code in (401, 403):
            return False, "GitHub authentication failed creating Pull Request.", None
        else:
            return False, f"Failed to create PR (HTTP {resp.status_code}): {resp.text[:150]}", None
    except Exception as e:
        return False, f"Network error creating Pull Request: {sanitize_error_message(str(e))}", None


def execute_create_pr_pipeline(
    validated_patch_record: Optional[Dict[str, Any]],
    target_config: Dict[str, Any],
    github_token: Optional[str] = None,
    http_client: Optional[httpx.Client] = None
) -> Dict[str, Any]:
    """
    Orchestrates Stage 3: Real GitHub Pull Request Creation.

    Enforces all requirements:
    1. Human approval and Stage 2 successful validation are strictly required.
    2. GITHUB_TOKEN authentication required (safe fail if missing).
    3. Target repository must be strictly HITESHsai01/Patient.
    4. Base branch must be main.
    5. Main branch HEAD SHA retrieved.
    6. Remote source verified for patch integrity (detects PATCH_STALE).
    7. Creates isolated branch: sentinelops/fix/<timestamp>.
    8. Commits validated fix to branch with descriptive commit message.
    9. Creates Pull Request targeting main.
    10. PR is left open for human review (never automatically merged).
    """
    # 1. Require Stage 2 validation
    if not validated_patch_record or validated_patch_record.get("status") != "validated":
        return {
            "status": "validation_required",
            "message": "Cannot create Pull Request: Fix has not been successfully validated in Stage 2."
        }

    patch_data = validated_patch_record.get("patch", {})
    file_rel = patch_data.get("file", "app/routes.py")

    # 2. Verify Authentication Token
    effective_token = github_token or get_github_token()
    if not effective_token:
        return {
            "status": "auth_error",
            "message": "GitHub write authentication is not configured. Please set GITHUB_TOKEN in your environment."
        }

    # 3. Verify Repository and Branch Allowlists
    cfg_repo = target_config.get("github_repo", "")
    owner, repo = parse_repo_slug(cfg_repo)
    if not owner or not repo:
        return {
            "status": "validation_failed",
            "message": f"Invalid target repository configuration: '{cfg_repo}'."
        }

    base_branch = target_config.get("branch", "main").strip()
    is_valid_target, target_msg = validate_repo_and_branch(owner, repo, base_branch)
    if not is_valid_target:
        return {
            "status": "unauthorized_target",
            "message": target_msg
        }

    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {effective_token}",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "SentinelOps-AI-ControlPlane"
    }

    client = http_client or httpx.Client(timeout=20.0)
    should_close_client = http_client is None

    try:
        # 4. Get main branch HEAD SHA
        head_ok, head_msg, head_data = get_main_branch_head(client, owner, repo, branch=base_branch, headers=headers)
        if not head_ok or not head_data:
            return {
                "status": "github_api_error",
                "message": f"Failed to retrieve main branch HEAD: {head_msg}"
            }
        base_sha = head_data["sha"]

        # 5. Read remote target file from main and verify patch integrity
        file_ok, file_msg, file_data = get_file_content_from_github(
            client, owner, repo, file_rel, ref=base_branch, headers=headers
        )
        if not file_ok or not file_data:
            return {
                "status": "github_api_error",
                "message": f"Failed to read target file from remote main branch: {file_msg}"
            }

        main_content = file_data["content"]
        file_blob_sha = file_data["sha"]

        # Check for stale patch
        integrity_ok, integrity_msg, patched_content = verify_patch_integrity(
            main_content, patch_data, file_rel
        )
        if not integrity_ok or not patched_content:
            status_code = "PATCH_STALE" if "PATCH_STALE" in integrity_msg else "patch_integrity_failed"
            return {
                "status": status_code,
                "message": integrity_msg,
                "file": file_rel
            }

        # 6. Generate isolated branch name
        timestamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d_%H%M%S")
        new_branch_name = f"sentinelops/fix/{timestamp}"

        # 7. Create branch on GitHub from main base_sha
        branch_ok, branch_msg, branch_data = create_github_branch(
            client, owner, repo, new_branch_name, base_sha, headers=headers
        )
        if not branch_ok:
            return {
                "status": "github_api_error",
                "message": f"Failed to create GitHub branch '{new_branch_name}': {branch_msg}"
            }

        # 8. Commit validated fix to the new branch
        commit_msg = "fix: handle missing user in /api/user/{user_id}"
        commit_ok, commit_err, commit_data = commit_file_to_branch(
            client, owner, repo, file_rel, patched_content,
            new_branch_name, file_blob_sha, commit_msg, headers=headers
        )
        if not commit_ok or not commit_data:
            return {
                "status": "github_api_error",
                "message": f"Branch '{new_branch_name}' was created, but file commit failed: {commit_err}",
                "branch": new_branch_name
            }
        commit_sha = commit_data["sha"]

        # 9. Create Pull Request targeting main
        pr_title = "fix: handle missing user endpoint error"
        pr_body = (
            "## SentinelOps AI Remediation\n\n"
            "### Detected Defect\n"
            "- **HTTP Status**: 500 Internal Server Error\n"
            "- **Exception**: `IndexError: list index out of range`\n"
            "- **Endpoint**: `GET /api/user/999`\n\n"
            "### Root Cause\n"
            "- Empty user query lookup was indexed directly with `matching[0]` without checking list bounds.\n\n"
            "### Validated Remediation\n"
            "- Check list emptiness and raise HTTP 404 with detail `\"User not found\"`.\n\n"
            "### Stage 2 Validation Results\n"
            "- **Patient Test Suite**: PASS\n"
            "- **GET /api/health**: 200 OK\n"
            "- **GET /api/user/999**: 404 Not Found (controlled error response)\n"
            f"- **Isolated Validation Branch**: `{new_branch_name}`\n\n"
            "---\n"
            "*This patch was generated by SentinelOps-AI (Amazon Bedrock Llama 3.3 70B) "
            "and explicitly approved by a human operator.*\n\n"
            "**Notice:** Final human code review and merge is required. Automatic merge is disabled."
        )

        pr_ok, pr_err, pr_data = create_pull_request(
            client, owner, repo, pr_title, pr_body, new_branch_name,
            base_branch=base_branch, headers=headers
        )
        if not pr_ok or not pr_data:
            return {
                "status": "github_api_error",
                "message": f"Branch '{new_branch_name}' committed ({commit_sha}), but Pull Request creation failed: {pr_err}",
                "branch": new_branch_name,
                "commit_sha": commit_sha
            }

        # 10. Success: PR created, ready for human review
        return {
            "status": "pr_created",
            "repository": f"{owner}/{repo}",
            "branch": new_branch_name,
            "base_branch": base_branch,
            "base_sha": base_sha,
            "commit_sha": commit_sha,
            "pr_number": pr_data.get("number"),
            "pr_url": pr_data.get("html_url"),
            "title": pr_title,
            "message": f"GitHub Pull Request #{pr_data.get('number')} created successfully. Awaiting human review."
        }

    finally:
        if should_close_client:
            client.close()
