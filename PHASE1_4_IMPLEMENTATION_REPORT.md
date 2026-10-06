# SentinelOps-AI: Control-Plane Architecture Implementation Report (Steps 1–4)

> **Implementation Status**: Completed Steps 1–4  
> **Workspace**: `e:\coding\New folder\sentinal-ops`  
> **Execution State**: **STOPPED. Awaiting approval for Steps 5+ (GitHub integration & Agent target orchestration).**

---

## Executive Summary

SentinelOps-AI has been transformed from a purely simulated frontend + disconnected CLI script into a functional control-plane architecture:

1. **FastAPI Control Plane**: Created [app/api_server.py](file:///e:/coding/New%20folder/sentinal-ops/app/api_server.py) providing endpoints for target application configuration, runtime health probing, agent triggering, and operational status.
2. **SSRF Prevention & Security**: Created [app/security.py](file:///e:/coding/New%20folder/sentinal-ops/app/security.py) implementing strict URL scheme validation, DNS resolution, and IP range blocking (preventing loopback, RFC1918 private IPs, link-local, multicast, and cloud metadata access).
3. **Target Application UI**: Enhanced [dashboard/src/App.tsx](file:///e:/coding/New%20folder/sentinal-ops/dashboard/src/App.tsx) and [dashboard/src/App.css](file:///e:/coding/New%20folder/sentinal-ops/dashboard/src/App.css) with a new `TARGET APPLICATION` card supporting `Application Name`, `Demo / Deployment URL`, `GitHub Repository`, and `Branch`, featuring real-time status indicators (`Connected`, `Healthy`, `Unhealthy`).
4. **Real HTTP Health Probe**: Replaced fake `setTimeout()` mocks for the target with genuine HTTP probes that measure live status codes and response latency.
5. **Dual Mode Trigger**: Preserved the original `Trigger Alarm Simulation` button while adding a `Trigger Real Test` button that calls the backend API.
6. **Development Proxy**: Configured [dashboard/vite.config.ts](file:///e:/coding/New%20folder/sentinal-ops/dashboard/vite.config.ts) to proxy `/api` calls directly to the FastAPI backend.

---

## 1. Files Changed & Created

| File | Status | Description |
|---|---|---|
| [app/api_server.py](file:///e:/coding/New%20folder/sentinal-ops/app/api_server.py) | **Created** | FastAPI backend control plane (`/api/target/configure`, `/api/target`, `/api/target/health`, `/api/agent/trigger`, `/api/agent/status`, `/api/health`). |
| [app/security.py](file:///e:/coding/New%20folder/sentinal-ops/app/security.py) | **Created** | SSRF prevention (IP resolution check against loopback, private, link-local, metadata) and GitHub repository URL format validation. |
| [dashboard/src/App.tsx](file:///e:/coding/New%20folder/sentinal-ops/dashboard/src/App.tsx) | **Modified** | Integrated Target Application form, real health check probes, status badge transitions, and real test trigger. |
| [dashboard/src/App.css](file:///e:/coding/New%20folder/sentinal-ops/dashboard/src/App.css) | **Modified** | Styled the Target Application card, inputs, responsive grid, pulsating badges, and status feedback banners. |
| [dashboard/vite.config.ts](file:///e:/coding/New%20folder/sentinal-ops/dashboard/vite.config.ts) | **Modified** | Configured Vite dev server proxy to forward `/api` requests to `http://127.0.0.1:8000`. |
| [requirements.txt](file:///e:/coding/New%20folder/sentinal-ops/requirements.txt) | **Modified** | Defined minimum backend and testing dependencies (`fastapi`, `uvicorn`, `pydantic`, `httpx`, `boto3`, `pytest`). |
| [.env.example](file:///e:/coding/New%20folder/sentinal-ops/.env.example) | **Created** | Clean environment configuration template with placeholders only. |
| [tests/test_api_server.py](file:///e:/coding/New%20folder/sentinal-ops/tests/test_api_server.py) | **Created** | 18 unit and integration tests covering security, SSRF blocks, configuration validation, and API endpoints. |

---

## 2. New API Endpoints

### `POST /api/target/configure`
Configures and stores target application metadata on the backend.
- **Request Body**:
  ```json
  {
    "name": "SentinelOps Demo",
    "demo_url": "https://example.com",
    "github_repo": "https://github.com/BLACKSKY2099/SentinelOps-AI",
    "branch": "main",
    "cloudwatch_log_group": "/aws/ops-pilot/sacrificial-app",
    "cloudwatch_log_stream": "production-errors",
    "aws_region": "us-east-1"
  }
  ```
- **Validation**:
  - `name`: Non-empty string.
  - `demo_url`: Valid HTTP/HTTPS scheme; passes SSRF checks.
  - `github_repo`: Valid GitHub repository URL regex.
  - `branch`: Non-empty string.
- **Response (200 OK)**:
  ```json
  {
    "status": "success",
    "message": "Target application 'SentinelOps Demo' successfully configured.",
    "target": { ... }
  }
  ```

### `GET /api/target`
Retrieves currently configured target application metadata.
- **Response (200 OK)**:
  ```json
  {
    "configured": true,
    "target": {
      "name": "SentinelOps Demo",
      "demo_url": "https://example.com",
      "github_repo": "https://github.com/BLACKSKY2099/SentinelOps-AI",
      "repo_slug": "BLACKSKY2099/SentinelOps-AI",
      "branch": "main",
      "status": "Connected"
    }
  }
  ```

### `GET /api/target/health`
Performs a live HTTP probe against the target's `demo_url`.
- **Validation**: Validates SSRF before requesting.
- **Response (200 OK - Healthy)**:
  ```json
  {
    "healthy": true,
    "status_code": 200,
    "latency_ms": 121.68,
    "error": null,
    "timestamp": "2026-10-04T17:40:28.054876+00:00",
    "target_url": "https://example.com"
  }
  ```
- **Response (200 OK - Unhealthy)**:
  ```json
  {
    "healthy": false,
    "status_code": 500,
    "latency_ms": 65.4,
    "error": "HTTP 500 Internal Server Error",
    "timestamp": "...",
    "target_url": "https://example.com"
  }
  ```

### `POST /api/agent/trigger`
Triggers real agent execution without faking remediation.
- **Response (200 OK)**:
  ```json
  {
    "status": "triggered",
    "target": "SentinelOps Demo",
    "demo_url": "https://example.com",
    "github_repo": "https://github.com/BLACKSKY2099/SentinelOps-AI",
    "branch": "main",
    "cloudwatch_status": "CloudWatch target not configured.",
    "message": "Real test event registered for target 'SentinelOps Demo'. Operational telemetry checked."
  }
  ```

### `GET /api/agent/status`
Returns execution state of the agent and last recorded health telemetry.

### `GET /api/health`
API server health check.

---

## 3. How to Start Backend

From the project root:

```bash
python -m uvicorn app.api_server:app --host 127.0.0.1 --port 8000 --reload
```

---

## 4. How to Start Dashboard

From the `dashboard/` directory:

```bash
cd dashboard
npm run dev
```

Open your browser to: **`http://localhost:5173/`**

---

## 5. Example curl Commands

### A. Configure Target Application
```bash
curl -X POST http://127.0.0.1:8000/api/target/configure \
  -H "Content-Type: application/json" \
  -d '{
    "name": "SentinelOps Demo",
    "demo_url": "https://example.com",
    "github_repo": "https://github.com/BLACKSKY2099/SentinelOps-AI",
    "branch": "main"
  }'
```

### B. Retrieve Current Target
```bash
curl http://127.0.0.1:8000/api/target
```

### C. Run Real Health Probe
```bash
curl http://127.0.0.1:8000/api/target/health
```

### D. Trigger Real Agent Execution
```bash
curl -X POST http://127.0.0.1:8000/api/agent/trigger
```

---

## 6. Test Results

### Python Unit & Integration Test Suite
```bash
python -m unittest discover -s tests
```
```
...................
----------------------------------------------------------------------
Ran 19 tests in 0.218s

OK
```
*Tests pass 100%, covering SSRF blocks (loopback, private IP, metadata), GitHub repository parsing, target persistence, and mock health probes.*

### Dashboard Production Build
```bash
cd dashboard && npm run build
```
```
vite v8.1.4 building client environment for production...
✓ 17 modules transformed.
dist/index.html                   0.81 kB │ gzip:  0.45 kB
dist/assets/index-DDiyOs08.css   16.87 kB │ gzip:  3.84 kB
dist/assets/index-CV09tk20.js   223.44 kB │ gzip: 68.54 kB
✓ built in 775ms
```

### End-to-End Browser Flow
Verified via live browser session on `http://localhost:5173/`:
1. Navigated to dashboard; verified page title and Target Application section.
2. Verified default target values loaded.
3. Clicked **[ Connect Target ]** → backend stored target; badge updated to **`Target Status: Connected`**.
4. Clicked **[ Check Health ]** → backend sent real HTTP probe to `https://example.com`; badge updated to **`Target Status: Healthy`** with **HTTP 200** and latency **121.68ms**.
5. Clicked **[ Trigger Real Test ]** → real agent trigger appeared in terminal console.
6. Verified original **[ Trigger Alarm Simulation ]** button operates independently as expected.

---

## 7. Errors Encountered & Resolved

1. **TestClient / httpx Patching Conflict**: Initial unit tests patched `httpx.Client.get`, which inadvertently intercepted Starlette's `TestClient` internal transport. Resolved by isolating target probes into `probe_target_url()` in [app/api_server.py](file:///e:/coding/New%20folder/sentinal-ops/app/api_server.py), keeping test client routing unaffected.
2. **Missing Frontend Dependencies**: The freshly cloned repository needed `npm install` in `dashboard/` to provide TypeScript compiler (`tsc`) and Vite binaries.
3. **CORS & Port Alignment**: Added Vite development server proxy configuration in [dashboard/vite.config.ts](file:///e:/coding/New%20folder/sentinal-ops/dashboard/vite.config.ts) and FastAPI `CORSMiddleware` in [app/api_server.py](file:///e:/coding/New%20folder/sentinal-ops/app/api_server.py) to ensure seamless local operation on both `localhost:5173` and `localhost:8000`.

---

## 8. AWS Dependencies for this Phase

- **Zero AWS resources created.**
- Steps 1–4 operate locally without requiring active AWS infrastructure or credentials.
- When optional CloudWatch log groups or Bedrock inference are configured in later phases, credentials will be read from environment variables or standard IAM roles.

---

## 9. Security Considerations Implemented

- **SSRF Prevention ([app/security.py](file:///e:/coding/New%20folder/sentinal-ops/app/security.py))**:
  - Enforces `http` and `https` schemes only.
  - Resolves hostnames to IP addresses using DNS before issuing requests.
  - Rejects loopback addresses (`127.0.0.0/8`, `::1`), private RFC1918 ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local addresses (`169.254.0.0/16`), cloud metadata services (`169.254.169.254`, `metadata.google.internal`), and multicast addresses.
- **Credential Protection**:
  - No access keys, secrets, or tokens are embedded in frontend source code.
  - Provided [.env.example](file:///e:/coding/New%20folder/sentinal-ops/.env.example) with placeholder variables only.

---

## Current Status

**STOP CONDITION HONORED.** All requirements for Steps 1–4 are fulfilled. Awaiting user approval to proceed with Step 5 & beyond (making orchestrator target-aware and implementing real GitHub read/branch/PR tools).
