# SentinelOps-AI: Architectural Audit & Deep-Dive Inspection Report

> **Inspection Status**: Complete  
> **Repository Cloned**: `https://github.com/BLACKSKY2099/SentinelOps-AI` into workspace `e:\coding\New folder\sentinal-ops`  
> **Code Modification Status**: **Zero code files modified. Zero AWS resources created. Zero deployments made.**

---

## Executive Summary & Ground Truth vs. README

A line-by-line audit of the cloned codebase reveals a fundamental gap between the marketing claims in [README.md](file:///e:/coding/New%20folder/sentinal-ops/README.md) and the actual implementation:

1. **The Dashboard is an entirely simulated static UI**: The React dashboard in [dashboard/src/App.tsx](file:///e:/coding/New%20folder/sentinal-ops/dashboard/src/App.tsx) contains **zero API calls** (no `fetch()`, `axios`, or WebSocket). Clicking *"Trigger Alarm Simulation"* runs JavaScript `setTimeout()` timers that append pre-canned mock log lines to a local React state array. It has no connection to any backend or AWS.
2. **There is NO Web Backend / API Server**: The repository contains no FastAPI, Flask, Express, or ASGI/WSGI server. [app/](file:///e:/coding/New%20folder/sentinal-ops/app) contains only a standalone script [app_simulator.py](file:///e:/coding/New%20folder/sentinal-ops/app/app_simulator.py).
3. **"GitHub MCP Server" has zero GitHub integration**: Despite the name [mcp_servers/github_server.py](file:///e:/coding/New%20folder/sentinal-ops/mcp_servers/github_server.py), it contains **no GitHub API calls, no PyGithub dependency, no git CLI commands, no commit/PR creation, and no authentication**. It simply performs local Python `open()` reads and writes to local disk files in the workspace.
4. **Hardcoded Remediation Target**: The autonomous agent loop in [agent/orchestrator.py](file:///e:/coding/New%20folder/sentinal-ops/agent/orchestrator.py#L60) hardcodes `app/app_simulator.py` as the only target file it can inspect and patch.
5. **Phantom AWS Services in README**: The README claims integration with **S3, Kinesis Data Streams, ECS, EC2, SNS, SQS, AWS CDK, and Terraform**. In actual source code, **none of these exist**. The only AWS services referenced in code are **AWS CloudWatch Logs** and **Amazon Bedrock Runtime**.
6. **Infrastructure As Code is Empty**: [infra/template.yaml](file:///e:/coding/New%20folder/sentinal-ops/infra/template.yaml) is a 0-byte blank file. [infra/lambda_ingestion.py](file:///e:/coding/New%20folder/sentinal-ops/infra/lambda_ingestion.py#L35) is an incomplete stub with `# TODO: Phase 3 will inject the Amazon Bedrock Agent invocation client right here.`
7. **Empty Requirements File**: Root [requirements.txt](file:///e:/coding/New%20folder/sentinal-ops/requirements.txt) is completely empty (0 bytes). The root [Dockerfile](file:///e:/coding/New%20folder/sentinal-ops/Dockerfile#L22) falls back to `pip install boto3 botocore pytest`.

---

## SECTION A: Current Architecture

Based on the actual source code, the system consists of **two completely decoupled subsystems**:

```
[ SUBSYSTEM 1: FRONTEND DEMO (Client-Only Simulation) ]
User Browser
    ↓
Vite / React 19 ([App.tsx](file:///e:/coding/New%20folder/sentinal-ops/dashboard/src/App.tsx))
    ↓
Clicks "Trigger Alarm Simulation"
    ↓
React setTimeout() timers (0s → 2.5s → 5.0s → 8.0s → 11.0s → 14.0s)
    ↓
Renders pre-canned hardcoded mock logs + hardcoded diff in terminal window
(NO connection to Python backend, AWS CloudWatch, Bedrock, or GitHub)


[ SUBSYSTEM 2: BACKEND CLI / AGENT (Run manually via Terminal) ]
CLI User / Local Process
    ↓
[app/app_simulator.py](file:///e:/coding/New%20folder/sentinal-ops/app/app_simulator.py) (simulate_crash())
    ↓ (boto3 client.put_log_events)
AWS CloudWatch Logs (/aws/ops-pilot/sacrificial-app, stream: production-errors)
    ↓ (Manual CLI execution)
[agent/orchestrator.py](file:///e:/coding/New%20folder/sentinal-ops/agent/orchestrator.py) (run_orchestrator_loop())
    ↓ (boto3 bedrock_client.converse)
Amazon Bedrock (us.meta.llama3-3-70b-instruct-v1:0)
    ↓ (Text substring matching: "fetch_cloudwatch_logs", "read_file", "patch_file", "execute_tests")
[mcp_servers/aws_server.py](file:///e:/coding/New%20folder/sentinal-ops/mcp_servers/aws_server.py) → logs_client.get_log_events()
[mcp_servers/github_server.py](file:///e:/coding/New%20folder/sentinal-ops/mcp_servers/github_server.py) → local open('app/app_simulator.py')
[mcp_servers/sandbox_server.py](file:///e:/coding/New%20folder/sentinal-ops/mcp_servers/sandbox_server.py) → subprocess.run('python -m unittest discover -s tests')
    ↓
Loop terminates when LLM output text contains "PASSED" or "ready for a Human Code Review"
```

### Detailed Component Execution Breakdown

1. **Where Error Enters**:
   - In Subsystem 1: Generated purely in memory via React state when the button is clicked.
   - In Subsystem 2: Executed manually via `python app/app_simulator.py`. Function [simulate_crash()](file:///e:/coding/New%20folder/sentinal-ops/app/app_simulator.py#L9-L38) triggers an out-of-bounds array access (`arr = [2, 3]; print(arr[15])`), formats the traceback, and calls `boto3.client('logs').put_log_events` to push the error event to CloudWatch Log Group `/aws/ops-pilot/sacrificial-app`.
2. **How Error Reaches Agent**:
   - The Lambda event handler [infra/lambda_ingestion.py](file:///e:/coding/New%20folder/sentinal-ops/infra/lambda_ingestion.py) was intended to trigger on EventBridge CloudWatch alarms, but it is not connected to Bedrock or the orchestrator.
   - In actual code, the user manually executes `python agent/orchestrator.py`, which is hardcoded at line 91 with `run_orchestrator_loop("/aws/ops-pilot/sacrificial-app", "production-errors")`.
3. **How Agent Analyzes It**:
   - [orchestrator.py:call_llm()](file:///e:/coding/New%20folder/sentinal-ops/agent/orchestrator.py#L18-L32) calls Amazon Bedrock's Converse API with system prompt [agent/prompt_templates.py:SYSTEM_PROMPT](file:///e:/coding/New%20folder/sentinal-ops/agent/prompt_templates.py#L1-L22).
   - In Step 1, the LLM requests `fetch_cloudwatch_logs`. The orchestrator calls [mcp_servers/aws_server.py:fetch_cloudwatch_logs()](file:///e:/coding/New%20folder/sentinal-ops/mcp_servers/aws_server.py#L9-L23), which calls `boto3.client('logs').get_log_events()` and injects the retrieved crash stack trace back into the conversation history.
4. **How Agent Decides Action**:
   - Decision-making does not use formal Bedrock tool specifications (`toolConfig`). Instead, it relies on naive regex and string checks in the text returned by Bedrock:
     - `if "fetch_cloudwatch_logs" in response_text:`
     - `elif "read_file" in response_text:`
     - `elif "patch_file" in response_text:`
     - `elif "execute_tests" in response_text:`
5. **How MCP Tools Are Called**:
   - Tools are **NOT** called via MCP JSON-RPC protocol over standard input/output or HTTP SSE.
   - Instead, [agent/orchestrator.py](file:///e:/coding/New%20folder/sentinal-ops/agent/orchestrator.py#L11-L13) directly imports the Python functions `handle_mcp_request` as local Python function calls.
6. **How Remediation Happens**:
   - [mcp_servers/github_server.py:apply_code_fix()](file:///e:/coding/New%20folder/sentinal-ops/mcp_servers/github_server.py#L21-L52) overwrites `app/app_simulator.py` directly on the local disk using Python standard file I/O `open(normalized_path, 'w')` and appends a hardcoded audit comment banner.
   - If regex extraction fails to parse the new code from Bedrock's response, [agent/orchestrator.py](file:///e:/coding/New%20folder/sentinal-ops/agent/orchestrator.py#L74-L76) falls back to a hardcoded division-by-zero fix string.
7. **How Success Is Verified**:
   - [mcp_servers/sandbox_server.py:run_local_tests()](file:///e:/coding/New%20folder/sentinal-ops/mcp_servers/sandbox_server.py#L6-L31) executes `python -m unittest discover -s tests` via `subprocess.run()`.
   - In [tests/test_app_simulator.py](file:///e:/coding/New%20folder/sentinal-ops/tests/test_app_simulator.py#L18-L22), the test catches all general exceptions except `ZeroDivisionError`:
     ```python
     except ZeroDivisionError:
         self.fail("Regression Found: Application still crashes with a raw ZeroDivisionError!")
     except Exception as e:
         pass
     ```
   - When returncode is `0`, it outputs `{"status": "PASSED"}`. The agent sees `"PASSED"` and exits its loop.

---

## SECTION B: File Map

```
sentinal-ops/
├── .dockerignore                            # Excludes git, pycache, dist from Docker builds
├── .github/
│   └── workflows/
│       └── docker-ci.yml                    # GitHub Actions: builds dashboard, tests container, pushes to GHCR
├── Dockerfile                               # Agent container image (Python 3.11 + AWS CLI v2 + boto3 + pytest)
├── README.md                                # Project documentation (claims Kinesis, S3, ECS, Terraform, etc.)
├── docker-compose.yml                       # Docker Compose defining 'dashboard' (8080:80) and 'agent' containers
├── requirements.txt                         # Currently EMPTY (0 bytes)
│
├── dashboard/                               # The "DOCTOR" UI (Standalone Vite + React 19 + TypeScript app)
│   ├── .gitignore
│   ├── .oxlintrc.json                       # Linter config (Oxlint)
│   ├── Dockerfile                           # Multi-stage Docker build: node:20-alpine -> nginx:alpine
│   ├── README.md                            # Vite template documentation
│   ├── index.html                           # Root HTML page, loads Inter font and /src/main.tsx
│   ├── nginx.conf                           # Nginx configuration for serving dist/ static assets
│   ├── package.json                         # Dependencies: react 19.2.7, react-dom 19.2.7; Dev: vite 8.1.1, oxlint, typescript
│   ├── package-lock.json
│   ├── vercel.json                          # Vercel rewrite configuration for SPA routing
│   ├── vite.config.ts                       # Vite React plugin setup
│   ├── tsconfig.json / tsconfig.app.json / tsconfig.node.json
│   ├── public/
│   │   ├── favicon.svg
│   │   └── icons.svg
│   └── src/
│       ├── main.tsx                         # React entry point mounting App to #root
│       ├── index.css                        # Design system tokens, color palettes, dark/light theme, keyframe animations
│       ├── App.css                          # Component styling, terminal console, code diff, responsive grid
│       ├── App.tsx                          # Single monolithic component containing entire UI, tabs, mock simulation state
│       └── assets/                          # Static demo assets (hero.png, react.svg, vite.svg)
│
├── app/                                     # Log ingestion / simulation script
│   └── app_simulator.py                     # Generates artificial crash (IndexError) and pushes log event to CloudWatch
│
├── agent/                                   # AI Agent Core
│   ├── orchestrator.py                      # Bedrock runtime client, prompt execution, loop handling, tool invocation
│   └── prompt_templates.py                  # OpsPilot SRE persona system prompt and tool definitions
│
├── mcp_servers/                             # Tool server modules
│   ├── aws_server.py                        # CloudWatch Logs tool: fetch_cloudwatch_logs via boto3
│   ├── github_server.py                     # Local file read/patch tool: read_file and patch_file via standard open()
│   └── sandbox_server.py                    # Test runner tool: execute_tests via python -m unittest subprocess
│
├── infra/                                   # Infrastructure stubs
│   ├── lambda_ingestion.py                  # AWS Lambda stub for EventBridge CloudWatch alarm events (incomplete)
│   └── template.yaml                        # SAM/CloudFormation template (EMPTY 0-byte file)
│
└── tests/                                   # Automated test suite
    └── test_app_simulator.py                # Unit test asserting app_simulator does not raise ZeroDivisionError
```

---

## SECTION C: Current AWS Services

Every AWS service analyzed directly from code:

| Service | Why It Is Used | Files Using It | Read Permissions | Write / Action Permissions | Required for Local Dev? | Required for Production? |
|---|---|---|---|---|---|---|
| **AWS CloudWatch Logs** | Pushes crash traces from the test app and fetches logs during agent diagnosis | [app/app_simulator.py](file:///e:/coding/New%20folder/sentinal-ops/app/app_simulator.py#L5)<br>[mcp_servers/aws_server.py](file:///e:/coding/New%20folder/sentinal-ops/mcp_servers/aws_server.py#L7) | `logs:GetLogEvents`<br>`logs:DescribeLogStreams`<br>`logs:FilterLogEvents` | `logs:PutLogEvents`<br>`logs:CreateLogGroup`<br>`logs:CreateLogStream` | **Optional** (only if running actual AWS CloudWatch sync; local mock bypasses this) | **Yes** (if ingesting real cloud logs) |
| **Amazon Bedrock Runtime** | Invokes LLM (`us.meta.llama3-3-70b-instruct-v1:0`) via Bedrock Converse API for error diagnosis and code fix generation | [agent/orchestrator.py](file:///e:/coding/New%20folder/sentinal-ops/agent/orchestrator.py#L16-L28) | None | `bedrock:InvokeModel` | **Optional** (required if running `agent/orchestrator.py` against live AWS Bedrock) | **Yes** |
| **AWS Lambda** | Handler stub designed to parse EventBridge alarm events | [infra/lambda_ingestion.py](file:///e:/coding/New%20folder/sentinal-ops/infra/lambda_ingestion.py#L7) | None | `lambda:InvokeFunction` (for deployment) | **No** (not hooked up or deployed) | **Optional** (only if using serverless ingestion) |
| **Amazon EventBridge** | Event schema parsed in Lambda stub | [infra/lambda_ingestion.py](file:///e:/coding/New%20folder/sentinal-ops/infra/lambda_ingestion.py#L9) | None | `events:PutRule`<br>`events:PutTargets` | **No** | **Optional** |
| **S3** | Claimed in README | None | None | None | **No** | **No** |
| **Kinesis Data Streams** | Claimed in README | None | None | None | **No** | **No** |
| **ECS / EC2** | Claimed in README | None | None | None | **No** | **No** |
| **SNS / SQS** | Claimed in README | None | None | None | **No** | **No** |
| **Secrets Manager / SSM**| Claimed in README | None | None | None | **No** | **No** |

---

## SECTION D: Current GitHub Integration

> **"GitHub integration is not currently implemented."**

Despite having a file named [mcp_servers/github_server.py](file:///e:/coding/New%20folder/sentinal-ops/mcp_servers/github_server.py), the implementation has no connection to GitHub:
- No GitHub REST or GraphQL API calls (`api.github.com`).
- No GitHub Personal Access Token (`GITHUB_TOKEN` or `GH_TOKEN`) handling.
- No PyGithub, Octokit, or Git CLI subprocess calls (`git clone`, `git commit`, `git push`, `gh pr create`).
- The functions [read_local_file()](file:///e:/coding/New%20folder/sentinal-ops/mcp_servers/github_server.py#L6-L19) and [apply_code_fix()](file:///e:/coding/New%20folder/sentinal-ops/mcp_servers/github_server.py#L21-L52) simply execute Python standard file system operations (`with open(...)`) on local workspace files.
- The claim in the dashboard log simulation (`"Created Pull Request #43 for Human Code Review"`) is a hardcoded string literal.

---

## SECTION E: Current Health Check

> **The system does NOT currently check an external deployment URL.**

There is no HTTP client library (`requests`, `httpx`, `aiohttp`, or `urllib.request`) anywhere in the Python backend or agent code. The codebase contains **zero mechanisms to probe an external URL**, verify an HTTP status code, measure response latency, or check a `/health` endpoint.

---

## SECTION F: Current "Trigger Alarm Simulation"

There are **two distinct and disconnected** "Trigger Alarm Simulations" in the repository:

1. **Dashboard Simulation ([dashboard/src/App.tsx:startSimulation](file:///e:/coding/New%20folder/sentinal-ops/dashboard/src/App.tsx#L56-L182))**:
   - Triggered by clicking the purple *"Trigger Alarm Simulation"* button on the web UI.
   - It is 100% hardcoded client-side React logic:
     - Sets state `simStep = 1` and `systemHealth = 'Degraded'`.
     - After 2500ms (Step 1): appends mock CloudWatch `[CRITICAL ERROR] IndexError: list index out of range` to the terminal array.
     - After 2500ms (Step 2): appends mock GitHub MCP read messages.
     - After 3000ms (Step 3): appends mock Bedrock reasoning and toggles `showDiff = true`, displaying a pre-coded diff block of lines 9-17 in `app_simulator.py`.
     - After 3000ms (Step 4): appends mock unit test output (`Ran 1 test in 0.042s OK`).
     - After 3000ms (Step 5): increments Autocures by 1, adds $50.00 to SRE Savings, sets `systemHealth = 'Healthy'`, and finishes.
   - **No network traffic leaves the browser.**

2. **Backend Script Simulation ([app/app_simulator.py](file:///e:/coding/New%20folder/sentinal-ops/app/app_simulator.py))**:
   - Triggered by running `python app/app_simulator.py` on the host or inside Docker.
   - Deliberately executes `arr = [2, 3]; print(arr[15])`.
   - Catches the `IndexError`, formats the stack trace with `traceback.format_exc()`, and executes `boto3.client('logs', region_name='us-east-1').put_log_events()` to CloudWatch Log Group `/aws/ops-pilot/sacrificial-app`.
   - This creates an actual log record in AWS CloudWatch if AWS credentials are configured.

---

## SECTION G: Current Remediation

> **Today, SentinelOps can only overwrite local disk files in the current repository path.**

Specifically:
- In [agent/orchestrator.py:line 60, 78](file:///e:/coding/New%20folder/sentinal-ops/agent/orchestrator.py#L60-L78), the agent explicitly targets `app/app_simulator.py`.
- When Bedrock provides a code patch, [mcp_servers/github_server.py:apply_code_fix()](file:///e:/coding/New%20folder/sentinal-ops/mcp_servers/github_server.py#L46-L47) opens that local file path and replaces its content on disk.
- It automatically appends an audit comment banner to the end of the file.
- **What it cannot remediate**:
  - Cannot restart services (no ECS/EC2/Kubernetes restart commands).
  - Cannot scale infrastructure (no Auto Scaling Group or CloudWatch alarm actions).
  - Cannot push changes or create Pull Requests on GitHub.
  - Cannot redeploy applications to staging or production URLs.

---

## SECTION H: Target Application Gap

To support the architecture where SentinelOps acts as the **DOCTOR** and monitors a separate **PATIENT** application configured via:
```json
{
    "name": "SentinelOps Demo",
    "demo_url": "https://example.com",
    "github_repo": "https://github.com/user/repository",
    "branch": "main"
}
```
the following architectural gaps must be bridged:

1. **Dashboard Target Section**:
   - The UI currently has no form inputs or state variables for target application metadata (`name`, `demo_url`, `github_repo`, `branch`, `connection status`).
2. **Missing Backend / API Layer**:
   - There is no API server to receive target configuration from the dashboard, persist it, or initiate actions.
   - A lightweight API server (e.g., FastAPI running on port 8000) or Vite server proxy is required.
3. **Target Decoupling in Agent**:
   - [agent/orchestrator.py](file:///e:/coding/New%20folder/sentinal-ops/agent/orchestrator.py) currently hardcodes `/aws/ops-pilot/sacrificial-app` and `app/app_simulator.py`.
   - The orchestrator must accept dynamic target context: target repository, target branch, target log identifiers, and target health check endpoints.
4. **Real GitHub Provider in MCP**:
   - [mcp_servers/github_server.py](file:///e:/coding/New%20folder/sentinal-ops/mcp_servers/github_server.py) must be upgraded to support cloning or fetching files from a remote GitHub repository via the GitHub REST API or local git workspace, creating a remediation branch, committing the fix, and generating a Pull Request.
5. **Runtime Health Check Provider**:
   - An HTTP probe mechanism must be added to ping the `demo_url`, verify HTTP 200/500 status, measure response latency, and confirm post-remediation recovery.

---

## SECTION I: Client-Side Error Gap

### Categorization of System Failures

| Failure Category | Can Current System Detect It? | Explanation |
|---|---|---|
| **1. Backend / Runtime Error** | **YES** (Partially) | Server-side unhandled exceptions (e.g., Python `IndexError`, `KeyError`, 500 crashes) write stack traces to standard logs, which are pushed to AWS CloudWatch Logs. |
| **2. Client-Side JavaScript Runtime Error** | **NO** | `window.onerror` and `unhandledrejection` occur exclusively inside the end-user's web browser engine (V8, JavaScriptCore). **CloudWatch server logs receive none of this data unless a browser telemetry client explicitly forwards it via HTTP.** |
| **3. Network / API Error** | **PARTIALLY** | If the request reaches the server and returns 502/504 or 4xx, server access logs record it. If the request fails in the browser due to CORS, DNS failure, client network disconnection, or client timeout, it is invisible to server CloudWatch logs. |
| **4. CSS / Layout / Visual Problem** | **NO** | CSS layout shifts, z-index clipping, broken fonts, or visual rendering bugs produce no runtime exceptions or HTTP errors. They cannot be detected by log ingestion or AST code analysis. |

### What Needs to Be Added for Browser Errors
If the "Patient" demo app has client-side errors that SentinelOps should heal, the architecture requires:
1. **Client-Side Telemetry Collector in Patient App**:
   - A lightweight error listener snippet in the demo app's `index.html` or entry point:
     ```javascript
     window.onerror = (msg, url, line, col, error) => {
       fetch(`${SENTINELOPS_API_URL}/api/telemetry/errors`, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ type: 'uncaught_exception', message: msg, file: url, line, stack: error?.stack })
       });
     };
     window.onunhandledrejection = (event) => {
       fetch(`${SENTINELOPS_API_URL}/api/telemetry/errors`, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ type: 'unhandled_rejection', reason: event.reason })
       });
     };
     ```
   - Alternatively: AWS CloudWatch RUM (Real User Monitoring) web client if AWS-native routing is preferred.
2. **SentinelOps Telemetry Ingestion Endpoint**:
   - A server endpoint (`POST /api/telemetry/errors`) in SentinelOps that receives browser crashes, buffers them, and triggers the OpsPilot agent with client stack context.

---

## SECTION J: AWS Access Requirements

### Least-Privilege IAM Policy for SentinelOps

To run SentinelOps against an AWS account with least-privilege access, attach the following scoped IAM policy to your IAM user or role:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SentinelOpsCloudWatchReadLogs",
      "Effect": "Allow",
      "Action": [
        "logs:DescribeLogGroups",
        "logs:DescribeLogStreams",
        "logs:GetLogEvents",
        "logs:FilterLogEvents"
      ],
      "Resource": "arn:aws:logs:us-east-1:*:log-group:/aws/ops-pilot/*"
    },
    {
      "Sid": "SentinelOpsCloudWatchWriteLogsSimulation",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:us-east-1:*:log-group:/aws/ops-pilot/*"
    },
    {
      "Sid": "SentinelOpsBedrockConverseInference",
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream"
      ],
      "Resource": [
        "arn:aws:bedrock:us-east-1::foundation-model/us.meta.llama3-3-70b-instruct-v1:0",
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-*"
      ]
    }
  ]
}
```

### Permission Scope Categorization

1. **Read-Only Permissions**:
   - `logs:DescribeLogGroups`, `logs:DescribeLogStreams`, `logs:GetLogEvents`, `logs:FilterLogEvents`
   - Purpose: Fetching stack traces for root cause analysis.
2. **Remediation Permissions**:
   - **None required on AWS today**. Remediation is performed via code patching (GitHub/workspace file I/O). If AWS infrastructure remediation (e.g. ECS task restart) is added in the future, it would require `ecs:UpdateService` or `ecs:RestartTask`.
3. **Deployment Permissions**:
   - If deploying the Lambda ingestion stub ([infra/lambda_ingestion.py](file:///e:/coding/New%20folder/sentinal-ops/infra/lambda_ingestion.py)): `lambda:CreateFunction`, `lambda:UpdateFunctionCode`, `iam:PassRole`, `events:PutRule`, `events:PutTargets`.
   - *Not required for local dashboard and agent operation.*
4. **CloudWatch Specific Permissions**:
   - `logs:PutLogEvents` (used strictly by [app/app_simulator.py](file:///e:/coding/New%20folder/sentinal-ops/app/app_simulator.py#L27) to write simulated crash records).
5. **Bedrock Specific Permissions**:
   - `bedrock:InvokeModel` (used strictly by [agent/orchestrator.py:call_llm](file:///e:/coding/New%20folder/sentinal-ops/agent/orchestrator.py#L21) to invoke LLMs via Bedrock Converse API).
6. **Testing Permissions**:
   - Zero AWS permissions required. Local tests run entirely in Python unittest / pytest sandbox.
7. **Best Practice Guidance**:
   - **Never** use the AWS root account.
   - Use an IAM User with MFA or an IAM Role assumed via AWS IAM Identity Center (SSO).
   - Never commit `.env` or credentials to git.

---

## SECTION K: Implementation Plan (For Future Execution)

When approval is granted to implement the Target Application feature, here is the granular, step-by-step roadmap:

### Step 1: Add Target Application Section to Existing Dashboard
- **FILE**: [dashboard/src/App.tsx](file:///e:/coding/New%20folder/sentinal-ops/dashboard/src/App.tsx)
- **CHANGE**: Add a new card component `Target Application` above or inside the dashboard metrics grid with fields: `Application Name`, `Demo / Deployment URL`, `GitHub Repository`, `Branch`, `Connect Target` action button, and a status indicator (`Not Connected` / `Connected` / `Unhealthy` / `Healing`).
- **WHY**: Gives the DOCTOR UI visibility and control over which PATIENT application is being monitored.
- **RISK**: Low. Uses the existing CSS token variables and card styling from [App.css](file:///e:/coding/New%20folder/sentinal-ops/dashboard/src/App.css); preserves existing dashboard aesthetics.

### Step 2: Establish Backend API Gateway (Connecting Doctor UI to Agent)
- **FILE**: New file `app/api_server.py` (FastAPI or lightweight Python HTTP server) + update [requirements.txt](file:///e:/coding/New%20folder/sentinal-ops/requirements.txt)
- **CHANGE**: Expose endpoints:
  - `POST /api/target/configure` (stores target settings)
  - `GET /api/target/health` (executes HTTP probe against `demo_url`)
  - `POST /api/agent/trigger` (triggers orchestrator loop with target metadata)
  - `GET /api/agent/stream` (SSE stream sending live agent logs and diffs to the dashboard terminal)
  - `POST /api/telemetry/errors` (ingests client-side browser/telemetry errors)
- **WHY**: Bridges the decoupled React dashboard and the Python agent loop, replacing the client-only `setTimeout()` simulation with genuine live telemetry and execution.
- **RISK**: Medium. Must handle CORS properly for local Vite dev (`localhost:5173`) and containerized Nginx (`localhost:8080`).

### Step 3: Implement HTTP Health Check Tool
- **FILE**: New file `mcp_servers/health_server.py` or addition to [mcp_servers/sandbox_server.py](file:///e:/coding/New%20folder/sentinal-ops/mcp_servers/sandbox_server.py)
- **CHANGE**: Implement `check_http_health(url, expected_status=200, timeout=5)`:
  - Probes the `demo_url`.
  - Records response status, latency, and body health signature.
  - Used before remediation (to verify Unhealthy status) and after remediation (to verify Recovery).
- **WHY**: Fulfills the requirement that the Demo URL is used for runtime health checks and recovery verification.
- **RISK**: Low. Add URL validation and private IP filtering to prevent Server-Side Request Forgery (SSRF).

### Step 4: Upgrade GitHub MCP Server for Remote Repositories
- **FILE**: [mcp_servers/github_server.py](file:///e:/coding/New%20folder/sentinal-ops/mcp_servers/github_server.py)
- **CHANGE**: 
  - Add GitHub API or git workspace handling using `GITHUB_TOKEN` from environment.
  - Support reading files from a target repo/branch.
  - Support committing a remediation patch to a new branch (`fix/sentinelops-autocure-<id>`) and opening a Pull Request.
- **WHY**: Fulfills the requirement that the GitHub repository is used for source inspection, patch generation, and PR creation rather than just local file edits.
- **RISK**: Medium. Requires fine-grained GitHub token permissions (`contents:write`, `pull_requests:write`).

### Step 5: Make Orchestrator Target-Aware
- **FILE**: [agent/orchestrator.py](file:///e:/coding/New%20folder/sentinal-ops/agent/orchestrator.py) & [agent/prompt_templates.py](file:///e:/coding/New%20folder/sentinal-ops/agent/prompt_templates.py)
- **CHANGE**: Remove hardcoded strings `app/app_simulator.py` and `/aws/ops-pilot/sacrificial-app`. Inject dynamic target context (`target.name`, `target.demo_url`, `target.github_repo`, `target.branch`) into the prompt and loop.
- **WHY**: Enables the agent to heal any connected patient app rather than only the built-in simulator.
- **RISK**: Low. Fallback defaults will ensure existing tests and local simulations still pass.

---

## SECTION L: Final Architecture

```
                                  SENTINELOPS-AI
                                  (THE "DOCTOR")
   ┌────────────────────────────────────────────────────────────────────────┐
   │                                                                        │
   │  ┌──────────────────────────────────────────────────────────────────┐  │
   │  │                     DASHBOARD (React + Vite)                     │  │
   │  │                                                                  │  │
   │  │  [ Status: Active ]   [ Autocures: 42 ]   [ SRE Savings: $2,450 ]│  │
   │  │  ──────────────────────────────────────────────────────────────  │  │
   │  │  🎯 TARGET APPLICATION CONFIGURATION                             │  │
   │  │     Name: [ SentinelOps Demo ]                                   │  │
   │  │     Demo URL: [ https://demo-patient.example.com ]               │  │
   │  │     GitHub Repo: [ https://github.com/user/patient-app ]         │  │
   │  │     Branch: [ main ]                                             │  │
   │  │     Status: [ ● Connected / Healthy ]                            │  │
   │  │  ──────────────────────────────────────────────────────────────  │  │
   │  │  💻 HEALING LOOP CONSOLE (Live SSE Terminal Stream)              │  │
   │  └─────────────────────────────────┬────────────────────────────────┘  │
   │                                    │ HTTP / SSE                        │
   │                                    ▼                                   │
   │  ┌──────────────────────────────────────────────────────────────────┐  │
   │  │                   BACKEND API (FastAPI Gateway)                  │  │
   │  │        /api/target  •  /api/agent/trigger  •  /api/telemetry     │  │
   │  └──────────────────┬───────────────────────────────┬───────────────┘  │
   │                     │                               │                  │
   │                     ▼                               ▼                  │
   │  ┌──────────────────────────────────┐  ┌────────────────────────────┐  │
   │  │      HEALTH MONITOR SERVICE      │  │      AI AGENT CORE         │  │
   │  │   Periodic HTTP probes & pings   │  │    (OpsPilot Bedrock)      │  │
   │  └──────────────────┬───────────────┘  └────────────┬───────────────┘  │
   │                     │                               │                  │
   │                     │                               ▼                  │
   │                     │                  ┌────────────────────────────┐  │
   │                     │                  │        MCP SERVERS         │  │
   │                     │                  │  AWS • GitHub • Sandbox    │  │
   │                     │                  └────────────┬───────────────┘  │
   └─────────────────────┼───────────────────────────────┼──────────────────┘
                         │                               │
            HTTP Health  │                               │ Git Patch / PR
            Check / Probe│                               │ Creation
                         ▼                               ▼
       ┌──────────────────────────────────┐  ┌──────────────────────────────┐
       │           DEPLOYED URL           │  │      GITHUB REPOSITORY       │
       │  https://demo-patient.app.com    │  │  https://github.com/...      │
       │                                  │  │                              │
       │        • HTTP Status (200/500)   │  │      • Source Code Files     │
       │        • Response Latency        │  │      • Bug Location          │
       │        • Live Endpoint Ping      │  │      • Remediation Branch    │
       │        • Recovery Verification   │  │      • Pull Request Creation │
       └─────────────────┬────────────────┘  └──────────────┬───────────────┘
                         │                                  │
                         └─────────────────┬────────────────┘
                                           │
                                           ▼
                                   TARGET APPLICATION
                                    (THE "PATIENT")
                                           │
                                1. Deliberate Fault
                             (e.g., KeyError in /order)
                                           │
                                2. Telemetry / Logs
                             (CloudWatch / Ingest API)
                                           │
                                           ▼
                                 SentinelOps Detects
                                           │
                                 OpsPilot Analyzes
                                           │
                             Inspects Repo & Patches Bug
                                           │
                             Patient Redeploys / Restarts
                                           │
                              Verify Recovery via URL
                                     (HTTP 200)
```
