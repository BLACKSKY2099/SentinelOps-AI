import ipaddress
import re
import socket
from urllib.parse import urlparse
from typing import Tuple

GITHUB_URL_REGEX = re.compile(
    r"^https?://(www\.)?github\.com/([a-zA-Z0-9_\-\.]+)/([a-zA-Z0-9_\-\.]+?)(?:\.git)?(?:/)?$"
)

# Common cloud metadata hosts and IPs
BLOCKED_HOSTNAMES = {
    "localhost",
    "metadata.google.internal",
    "instance-data",
}

BLOCKED_EXPLICIT_IPS = {
    "169.254.169.254",  # AWS / GCP / Azure metadata service
    "fd00:ec2::254",     # AWS IPv6 IMDS
}


def validate_target_url_ssrf(url: str, allow_local_patient: bool = True) -> Tuple[bool, str]:
    """
    Validates a URL against Server-Side Request Forgery (SSRF) vulnerabilities.
    
    Rules:
    - Scheme must be http or https
    - Hostname must not be in blocked cloud metadata hosts
    - In local development mode (allow_local_patient=True), http://localhost:8001 and
      http://127.0.0.1:8001 are explicitly allowed as the designated SentinelOps-Patient app.
    - All other localhost ports, loopback addresses, and private network IPs are rejected.
    - In production mode (allow_local_patient=False), all localhost/loopback addresses are rejected.
    - Hostname must resolve to valid public IP addresses (not loopback, private, link-local, multicast).
    """
    if not url or not isinstance(url, str):
        return False, "Target URL must be a non-empty string."

    try:
        parsed = urlparse(url.strip())
    except Exception as e:
        return False, f"Failed to parse target URL: {str(e)}"

    if parsed.scheme.lower() not in ("http", "https"):
        return False, f"Invalid URL scheme '{parsed.scheme}'. Only HTTP and HTTPS are allowed."

    hostname = parsed.hostname
    if not hostname:
        return False, "Target URL must have a valid hostname."

    hostname_lower = hostname.lower()

    # Cloud metadata hosts are always blocked unconditionally
    if hostname_lower in ("metadata.google.internal", "instance-data"):
        return False, f"Access to '{hostname}' is blocked for security (SSRF prevention)."

    # Explicit Cloud metadata IPs are always blocked unconditionally
    if hostname_lower in BLOCKED_EXPLICIT_IPS:
        return False, f"SSRF Protection: Access to cloud metadata IP '{hostname}' is blocked."

    # Designated Local Development Target: allow localhost / 127.0.0.1 specifically on port 8001
    if allow_local_patient and parsed.port == 8001 and hostname_lower in ("localhost", "127.0.0.1", "::1"):
        return True, "URL passed SSRF security checks (Local development target permitted on port 8001)."

    if hostname_lower in ("127.0.0.1", "::1"):
        return False, f"SSRF Protection: Loopback IP '{hostname}' is blocked."

    if hostname_lower in BLOCKED_HOSTNAMES:
        return False, f"Access to '{hostname}' is blocked for security (SSRF prevention)."

    # Resolve hostname to IPv4/IPv6 addresses
    try:
        addr_info = socket.getaddrinfo(hostname, None)
    except socket.gaierror as e:
        return False, f"DNS resolution failed for hostname '{hostname}': {str(e)}"
    except Exception as e:
        return False, f"Address resolution error for '{hostname}': {str(e)}"

    if not addr_info:
        return False, f"No IP addresses resolved for hostname '{hostname}'."

    for entry in addr_info:
        ip_str = entry[4][0]
        if ip_str in BLOCKED_EXPLICIT_IPS:
            return False, f"SSRF Protection: Access to cloud metadata IP '{ip_str}' is blocked."

        try:
            ip_obj = ipaddress.ip_address(ip_str)
        except ValueError:
            return False, f"Invalid resolved IP address: {ip_str}"

        if ip_obj.is_loopback:
            return False, f"SSRF Protection: Loopback IP '{ip_str}' is blocked."
        if ip_obj.is_private:
            return False, f"SSRF Protection: Private network IP '{ip_str}' is blocked."
        if ip_obj.is_link_local:
            return False, f"SSRF Protection: Link-local IP '{ip_str}' is blocked."
        if ip_obj.is_multicast:
            return False, f"SSRF Protection: Multicast IP '{ip_str}' is blocked."
        if ip_obj.is_reserved or ip_obj.is_unspecified:
            return False, f"SSRF Protection: Reserved or unspecified IP '{ip_str}' is blocked."

    return True, "URL passed SSRF security checks."


def validate_github_repo_url(url: str) -> Tuple[bool, str]:
    """
    Validates that a URL is a valid GitHub repository URL.
    Returns (True, "owner/repo") if valid, otherwise (False, error_message).
    """
    if not url or not isinstance(url, str):
        return False, "GitHub repository URL must be a non-empty string."

    clean_url = url.strip()
    match = GITHUB_URL_REGEX.match(clean_url)
    if not match:
        return False, "Invalid GitHub repository URL. Expected format: https://github.com/owner/repository"

    owner = match.group(2)
    repo = match.group(3)

    if not owner or not repo:
        return False, "GitHub repository URL must include both owner and repository name."

    return True, f"{owner}/{repo}"
