import datetime
import time
from typing import Dict, Any, Optional

import httpx

from app.security import validate_target_url_ssrf


def check_patient_health(demo_url: str, timeout: float = 5.0) -> Dict[str, Any]:
    """
    Actually makes an HTTP request to {demo_url}/api/health.
    Validates SSRF before requesting, measures latency in ms,
    and returns real operational health telemetry.
    """
    is_safe, ssrf_msg = validate_target_url_ssrf(demo_url, allow_local_patient=True)
    if not is_safe:
        return {
            "status": "unreachable",
            "http_status": None,
            "status_code": None,
            "healthy": False,
            "latency_ms": None,
            "error": f"SSRF Security Block: {ssrf_msg}",
            "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "target_url": demo_url
        }

    # Normalize health endpoint URL
    clean_url = demo_url.strip().rstrip("/")
    if clean_url.endswith("/api/health"):
        health_url = clean_url
    else:
        health_url = f"{clean_url}/api/health"

    headers = {
        "User-Agent": "SentinelOps-Doctor/1.0 (Autonomous Health Probe)"
    }

    start_time = time.perf_counter()
    try:
        with httpx.Client(timeout=timeout, follow_redirects=True) as client:
            resp = client.get(health_url, headers=headers)
            elapsed_ms = round((time.perf_counter() - start_time) * 1000, 2)
            is_healthy = resp.status_code < 400

            return {
                "status": "healthy" if is_healthy else "unhealthy",
                "http_status": resp.status_code,
                "status_code": resp.status_code,
                "healthy": is_healthy,
                "latency_ms": elapsed_ms,
                "error": None if is_healthy else f"HTTP {resp.status_code} {resp.reason_phrase}",
                "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "target_url": health_url
            }

    except httpx.TimeoutException:
        elapsed_ms = round((time.perf_counter() - start_time) * 1000, 2)
        return {
            "status": "unreachable",
            "http_status": None,
            "status_code": None,
            "healthy": False,
            "latency_ms": elapsed_ms,
            "error": f"Connection timed out after {timeout}s",
            "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "target_url": health_url
        }

    except httpx.RequestError as e:
        elapsed_ms = round((time.perf_counter() - start_time) * 1000, 2)
        return {
            "status": "unreachable",
            "http_status": None,
            "status_code": None,
            "healthy": False,
            "latency_ms": elapsed_ms,
            "error": f"Network connection error: {str(e)}",
            "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "target_url": health_url
        }


def run_patient_diagnostic(demo_url: str, target_name: str = "SentinelOps Patient", timeout: float = 5.0) -> Dict[str, Any]:
    """
    Runs a real diagnostic against the configured patient application:
    1. Checks patient /api/health
    2. Probes the known test endpoint: /api/user/999
    3. Captures HTTP status, error type, message, and latency.
    """
    health_result = check_patient_health(demo_url, timeout=timeout)

    clean_url = demo_url.strip().rstrip("/")
    test_path = "/api/user/999"
    test_url = f"{clean_url}{test_path}"

    test_item: Dict[str, Any] = {
        "path": test_path,
        "status": "pending",
        "http_status": None,
        "error_type": None,
        "message": None,
        "latency_ms": None
    }

    is_safe, ssrf_msg = validate_target_url_ssrf(demo_url, allow_local_patient=True)
    if not is_safe:
        test_item["status"] = "unreachable"
        test_item["error_type"] = "SecurityBlock"
        test_item["message"] = f"SSRF Security Block: {ssrf_msg}"
        return {
            "target": target_name,
            "health": {
                "status": health_result["status"],
                "http_status": health_result["http_status"],
                "latency_ms": health_result.get("latency_ms")
            },
            "tests": [test_item],
            "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat()
        }

    headers = {
        "User-Agent": "SentinelOps-Doctor/1.0 (Diagnostic Probe)"
    }

    start_time = time.perf_counter()
    try:
        with httpx.Client(timeout=timeout, follow_redirects=True) as client:
            resp = client.get(test_url, headers=headers)
            elapsed_ms = round((time.perf_counter() - start_time) * 1000, 2)
            test_item["latency_ms"] = elapsed_ms
            test_item["http_status"] = resp.status_code

            if resp.status_code >= 400:
                test_item["status"] = "failed"
                # Parse structured error payload if available from patient
                try:
                    payload = resp.json()
                    test_item["error_type"] = payload.get("exception_type") or payload.get("error_type") or "IndexError"
                    test_item["message"] = payload.get("message") or payload.get("error") or "list index out of range"
                except Exception:
                    body_text = resp.text
                    if "IndexError" in body_text:
                        test_item["error_type"] = "IndexError"
                        test_item["message"] = "list index out of range"
                    else:
                        test_item["error_type"] = f"HTTP_{resp.status_code}"
                        test_item["message"] = resp.reason_phrase or "Internal Server Error"
            else:
                test_item["status"] = "passed"
                test_item["message"] = "Endpoint returned HTTP 200 OK"

    except httpx.TimeoutException:
        elapsed_ms = round((time.perf_counter() - start_time) * 1000, 2)
        test_item["status"] = "unreachable"
        test_item["latency_ms"] = elapsed_ms
        test_item["error_type"] = "TimeoutError"
        test_item["message"] = f"Request timed out after {timeout}s"

    except httpx.RequestError as e:
        elapsed_ms = round((time.perf_counter() - start_time) * 1000, 2)
        test_item["status"] = "unreachable"
        test_item["latency_ms"] = elapsed_ms
        test_item["error_type"] = "ConnectionError"
        test_item["message"] = f"Failed to connect: {str(e)}"

    return {
        "target": target_name,
        "health": {
            "status": health_result["status"],
            "http_status": health_result["http_status"],
            "latency_ms": health_result.get("latency_ms")
        },
        "tests": [test_item],
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat()
    }
