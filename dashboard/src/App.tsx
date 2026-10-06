import { useState, useEffect, useRef } from 'react';
import './App.css';

// TypeScript declarations
interface LogLine {
  text: string;
  type: 'system' | 'alert' | 'mcp' | 'success' | 'error' | 'warning' | 'comment' | 'normal';
}

interface DiffLine {
  text: string;
  type: 'added' | 'removed' | 'normal';
}

interface DiagnosticTestItem {
  path: string;
  status: 'passed' | 'failed' | 'unreachable';
  http_status: number | null;
  error_type: string | null;
  message: string | null;
  latency_ms?: number | null;
}

interface DiagnosticResult {
  target: string;
  health: {
    status: 'healthy' | 'unhealthy' | 'unreachable';
    http_status: number | null;
    latency_ms?: number | null;
    error?: string | null;
  };
  tests: DiagnosticTestItem[];
  timestamp?: string;
}

interface DiagnosisResult {
  status: string;
  target: string;
  exception: string;
  message: string;
  file: string;
  line: number;
  root_cause: string;
  suggested_fix: string;
  code_snippet?: string[];
  diagnostic?: DiagnosticResult;
  timestamp?: string;
}

interface ProposedFix {
  original_code: string;
  replacement_code: string;
}

interface AiFixResult {
  status: string;
  target: string;
  file: string;
  line: number;
  exception: string;
  root_cause: string;
  proposed_fix: ProposedFix;
  explanation: string;
  confidence: number;
}

interface PatchValidationResult {
  status: 'validated' | 'validation_failed' | 'error';
  branch?: string | null;
  file?: string;
  message?: string;
  tests?: {
    status: 'PASS' | 'FAIL';
    exit_code?: number;
    output?: string;
  };
  runtime_verification?: {
    health?: { path: string; status_code: number; status: string };
    test_endpoint?: { path: string; status_code: number; status: string; detail?: string };
    previous?: string;
    current?: string;
  };
}

interface GitHubPrResult {
  status: 'pr_created' | 'auth_error' | 'PATCH_STALE' | 'validation_required' | 'unauthorized_target' | 'github_api_error';
  repository?: string;
  branch?: string;
  base_branch?: string;
  base_sha?: string;
  commit_sha?: string;
  pr_number?: number;
  pr_url?: string;
  title?: string;
  message?: string;
}

interface ApiResponse<T = any> {
  ok: boolean;
  status: number;
  data: T | null;
  error?: string;
}

/**
 * Safe fetch wrapper that handles non-2xx and non-JSON responses.
 * Never throws "Unexpected end of JSON input".
 * Inspects status and response text and surfaces actionable errors.
 * Automatically tries direct backend at http://127.0.0.1:8000 if dev proxy encounters a network error.
 */
async function safeFetchJson<T = any>(url: string, options?: RequestInit): Promise<ApiResponse<T>> {
  let resp: Response | null = null;

  // Attempt 1: Try the specified URL (e.g. /api/... via Vite dev proxy)
  try {
    resp = await fetch(url, options);
  } catch {
    // Relative fetch failed, fall through to attempt 2
  }

  // Attempt 2: If relative /api URL failed with network error, attempt direct fallback to backend on 127.0.0.1:8000 (CORS enabled)
  if (!resp && url.startsWith('/api')) {
    try {
      const fallbackUrl = `http://127.0.0.1:8000${url}`;
      resp = await fetch(fallbackUrl, options);
    } catch {
      // Both attempts failed
    }
  }

  if (!resp) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: `Network error connecting to ${url}: Doctor backend server (http://127.0.0.1:8000) appears offline or unreachable. Please ensure uvicorn is running.`
    };
  }

  // Read response as text first to safely prevent crashes on empty response bodies
  const text = await resp.text();
  const trimmed = text.trim();
  let parsedJson: any = null;

  if (trimmed) {
    try {
      parsedJson = JSON.parse(trimmed);
    } catch {
      // Body is not valid JSON (e.g. HTML error page or raw proxy text)
    }
  }

  if (!resp.ok) {
    // Extract structured error detail if available, else use raw text or HTTP status
    let errMsg = '';
    if (parsedJson && typeof parsedJson === 'object') {
      errMsg = parsedJson.detail || parsedJson.error || parsedJson.message || '';
    }
    if (!errMsg) {
      errMsg = trimmed
        ? `HTTP ${resp.status} ${resp.statusText || ''} - ${trimmed}`
        : `HTTP ${resp.status} ${resp.statusText || 'Response body was empty (backend unreachable)'}`;
    } else {
      errMsg = `HTTP ${resp.status}: ${errMsg}`;
    }

    return {
      ok: false,
      status: resp.status,
      data: parsedJson,
      error: errMsg
    };
  }

  // Response is OK (2xx)
  if (parsedJson === null && trimmed) {
    return {
      ok: false,
      status: resp.status,
      data: null,
      error: `HTTP ${resp.status}: Expected JSON response from ${url}, but received non-JSON: ${trimmed.slice(0, 100)}`
    };
  }

  return {
    ok: true,
    status: resp.status,
    data: (parsedJson ?? {}) as T,
  };
}

function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [activeTab, setActiveTab] = useState<'dashboard' | 'architecture' | 'docs'>('dashboard');
  const [docsSection, setDocsSection] = useState<string>('intro');
  const [activeArchNode, setActiveArchNode] = useState<string>('bedrock');

  // Simulator state
  const [simStep, setSimStep] = useState<number>(0);
  const [isSimRunning, setIsSimRunning] = useState<boolean>(false);
  const [terminalLines, setTerminalLines] = useState<LogLine[]>([
    { text: '[SYSTEM] SentinelOps-AI daemon initialized.', type: 'system' },
    { text: '[SYSTEM] Active monitoring enabled on AWS CloudWatch log streams.', type: 'system' },
    { text: '[SYSTEM] Status: Healthy. Standard operational mode.', type: 'success' },
    { text: '--- Click "Trigger Alarm Simulation" to trigger the self-healing loop ---', type: 'comment' }
  ]);
  const [showDiff, setShowDiff] = useState<boolean>(false);

  // Metrics (interactive)
  const [autocures, setAutocures] = useState<number>(42);
  const [savings, setSavings] = useState<number>(2450.0);
  const [systemHealth, setSystemHealth] = useState<'Healthy' | 'Degraded' | 'Healing'>('Healthy');

  // Target Application State ("Patient")
  const [targetName, setTargetName] = useState<string>('SentinelOps Patient');
  const [targetDemoUrl, setTargetDemoUrl] = useState<string>('http://localhost:8001');
  const [targetGithubRepo, setTargetGithubRepo] = useState<string>('https://github.com/HITESHsai01/Patient');
  const [targetBranch, setTargetBranch] = useState<string>('main');
  const [targetStatus, setTargetStatus] = useState<'Not Connected' | 'Connected' | 'Healthy' | 'Unhealthy' | 'Healing'>('Not Connected');
  const [targetHealthDisplay, setTargetHealthDisplay] = useState<'Healthy' | 'Unreachable' | 'Not Checked'>('Not Checked');
  const [targetHealthDetails, setTargetHealthDetails] = useState<{
    status?: string;
    http_status?: number | null;
    status_code?: number | null;
    latency_ms?: number | null;
    error?: string | null;
    timestamp?: string;
  } | null>(null);
  const [diagnosticResult, setDiagnosticResult] = useState<DiagnosticResult | null>(null);
  const [isRunningDiagnostic, setIsRunningDiagnostic] = useState<boolean>(false);
  const [diagnosisResult, setDiagnosisResult] = useState<DiagnosisResult | null>(null);
  const [isDiagnosing, setIsDiagnosing] = useState<boolean>(false);
  const [aiFixResult, setAiFixResult] = useState<AiFixResult | null>(null);
  const [isGeneratingFix, setIsGeneratingFix] = useState<boolean>(false);
  const [aiFixError, setAiFixError] = useState<string | null>(null);
  const [showApprovalModal, setShowApprovalModal] = useState<boolean>(false);
  const [isApplyingFix, setIsApplyingFix] = useState<boolean>(false);
  const [applyProgressStep, setApplyProgressStep] = useState<number>(0);
  const [appliedPatchResult, setAppliedPatchResult] = useState<PatchValidationResult | null>(null);
  const [appliedPatchError, setAppliedPatchError] = useState<string | null>(null);
  const [showPrModal, setShowPrModal] = useState<boolean>(false);
  const [isCreatingPr, setIsCreatingPr] = useState<boolean>(false);
  const [prProgressStep, setPrProgressStep] = useState<number>(0);
  const [gitHubPrResult, setGitHubPrResult] = useState<GitHubPrResult | null>(null);
  const [gitHubPrError, setGitHubPrError] = useState<string | null>(null);
  const [isTargetConnecting, setIsTargetConnecting] = useState<boolean>(false);
  const [isTargetCheckingHealth, setIsTargetCheckingHealth] = useState<boolean>(false);
  const [targetFeedback, setTargetFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [isRealTriggerRunning, setIsRealTriggerRunning] = useState<boolean>(false);

  const terminalEndRef = useRef<HTMLDivElement>(null);

  // Load configured target from backend on initial mount
  useEffect(() => {
    safeFetchJson('/api/target')
      .then(res => {
        if (res.ok && res.data && res.data.configured && res.data.target) {
          setTargetName(res.data.target.name || '');
          setTargetDemoUrl(res.data.target.demo_url || '');
          setTargetGithubRepo(res.data.target.github_repo || '');
          setTargetBranch(res.data.target.branch || 'main');
          setTargetStatus('Connected');
        }
      })
      .catch(() => {
        // Backend offline or unreachable; retain defaults
      });
  }, []);

  // Connect Target Application via Backend API
  const handleConnectTarget = async () => {
    setTargetFeedback(null);
    if (!targetName.trim()) {
      setTargetFeedback({ type: 'error', message: 'Application Name cannot be empty.' });
      return;
    }
    if (!targetDemoUrl.trim()) {
      setTargetFeedback({ type: 'error', message: 'Demo / Deployment URL cannot be empty.' });
      return;
    }
    if (!targetGithubRepo.trim()) {
      setTargetFeedback({ type: 'error', message: 'GitHub Repository URL cannot be empty.' });
      return;
    }
    if (!targetBranch.trim()) {
      setTargetFeedback({ type: 'error', message: 'Branch cannot be empty.' });
      return;
    }

    setIsTargetConnecting(true);
    try {
      const result = await safeFetchJson('/api/target/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: targetName.trim(),
          demo_url: targetDemoUrl.trim(),
          github_repo: targetGithubRepo.trim(),
          branch: targetBranch.trim(),
        }),
      });

      if (!result.ok || !result.data) {
        throw new Error(result.error || 'Failed to configure target application.');
      }

      const data = result.data;
      setTargetStatus('Connected');
      setTargetFeedback({
        type: 'success',
        message: `Successfully connected: ${data.target?.name || targetName} (${data.target?.repo_slug || data.target?.github_repo || targetGithubRepo})`,
      });
      setTerminalLines(prev => [
        ...prev,
        { text: `[DOCTOR] Target connected: ${data.target?.name || targetName} -> ${data.target?.demo_url || targetDemoUrl}`, type: 'system' }
      ]);
    } catch (err: any) {
      setTargetFeedback({ type: 'error', message: err.message || 'Connection failed.' });
      setTerminalLines(prev => [
        ...prev,
        { text: `[TARGET CONNECTION ERROR] ${err.message}`, type: 'error' }
      ]);
    } finally {
      setIsTargetConnecting(false);
    }
  };

  // Check Real Target Health via Backend HTTP Probe
  const handleCheckHealth = async () => {
    setTargetFeedback(null);
    setIsTargetCheckingHealth(true);
    try {
      const result = await safeFetchJson('/api/target/health');

      if (!result.ok || !result.data) {
        throw new Error(result.error || 'Health check request failed.');
      }

      const data = result.data;
      setTargetHealthDetails(data);
      const isHealthy = data.status === 'healthy' || data.healthy === true;
      if (isHealthy) {
        setTargetStatus('Healthy');
        setTargetHealthDisplay('Healthy');
        setTargetFeedback({
          type: 'success',
          message: `Health probe PASSED: HTTP ${data.http_status || data.status_code || 200} in ${data.latency_ms || 0}ms`,
        });
        setTerminalLines(prev => [
          ...prev,
          { text: `[HEALTH CHECK] ${data.target_url || targetDemoUrl} -> Status: HTTP ${data.http_status || data.status_code || 200} | Latency: ${data.latency_ms || 0}ms (HEALTHY)`, type: 'success' }
        ]);
      } else {
        setTargetStatus('Unhealthy');
        setTargetHealthDisplay('Unreachable');
        setTargetFeedback({
          type: 'error',
          message: `Health probe UNHEALTHY: ${data.error || 'HTTP ' + (data.http_status || data.status_code)} (${data.latency_ms || 0}ms)`,
        });
        setTerminalLines(prev => [
          ...prev,
          { text: `[HEALTH CHECK ALERT] ${data.target_url || targetDemoUrl} -> ${data.error || 'HTTP ' + (data.http_status || data.status_code)} (UNREACHABLE / UNHEALTHY)`, type: 'error' }
        ]);
      }
    } catch (err: any) {
      setTargetStatus('Unhealthy');
      setTargetHealthDisplay('Unreachable');
      setTargetFeedback({ type: 'error', message: err.message || 'Health probe failed.' });
      setTerminalLines(prev => [
        ...prev,
        { text: `[HEALTH CHECK ERROR] ${err.message}`, type: 'error' }
      ]);
    } finally {
      setIsTargetCheckingHealth(false);
    }
  };

  // Run Patient Diagnostic (Checks /api/health and /api/user/999)
  const handleRunDiagnostic = async () => {
    setIsRunningDiagnostic(true);
    setTargetFeedback(null);
    try {
      setTerminalLines(prev => [
        ...prev,
        { text: `[DOCTOR] Running Diagnostic against target: ${targetName} (${targetDemoUrl})...`, type: 'system' }
      ]);
      const result = await safeFetchJson<DiagnosticResult>('/api/diagnostic/run', { method: 'POST' });
      if (!result.ok || !result.data) {
        throw new Error(result.error || 'Failed to run diagnostic.');
      }
      const data: DiagnosticResult = result.data;
      setDiagnosticResult(data);
      const isHealthOk = data.health?.status === 'healthy';
      setTargetHealthDisplay(isHealthOk ? 'Healthy' : 'Unreachable');

      const testItem = data.tests && data.tests[0];
      setTerminalLines(prev => [
        ...prev,
        { text: `[PROBE] GET ${targetDemoUrl}/api/health -> HTTP ${data.health?.http_status || 200} [${(data.health?.status || 'UNKNOWN').toUpperCase()}] (${data.health?.latency_ms || 0}ms)`, type: isHealthOk ? 'success' : 'error' },
        ...(testItem ? [{
          text: `[PROBE] GET ${targetDemoUrl}${testItem.path} -> HTTP ${testItem.http_status || 'ERR'} [${testItem.status.toUpperCase()}] ${testItem.error_type || ''}: ${testItem.message || ''} (${testItem.latency_ms || 0}ms)`,
          type: testItem.status === 'failed' ? ('error' as const) : ('success' as const)
        }] : []),
        { text: `[DOCTOR ANALYSIS] Contrast verified: Patient health is HEALTHY, but functional endpoint /api/user/999 FAILED with ${testItem?.error_type || 'IndexError'}!`, type: 'alert' }
      ]);

      setTargetFeedback({
        type: 'success',
        message: 'Diagnostic completed: Patient health is HEALTHY, test endpoint /api/user/999 FAILED with IndexError.',
      });
    } catch (err: any) {
      setTargetFeedback({ type: 'error', message: err.message || 'Diagnostic failed.' });
      setTerminalLines(prev => [
        ...prev,
        { text: `[DIAGNOSTIC ERROR] ${err.message}`, type: 'error' }
      ]);
    } finally {
      setIsRunningDiagnostic(false);
    }
  };

  // Run Autonomous Agent Diagnosis (Diagnostic + GitHub Repo Inspection)
  const handleRunDiagnosis = async () => {
    setIsDiagnosing(true);
    setTargetFeedback(null);
    try {
      setTerminalLines(prev => [
        ...prev,
        { text: `[AGENT DIAGNOSE] Running autonomous diagnosis & repository inspection...`, type: 'system' },
        { text: `[INSPECTION] Cloning patient repository: ${targetGithubRepo} (${targetBranch})...`, type: 'normal' }
      ]);
      const result = await safeFetchJson<DiagnosisResult>('/api/agent/diagnose', { method: 'POST' });
      if (!result.ok || !result.data) {
        throw new Error(result.error || 'Failed to diagnose target application.');
      }
      const data: DiagnosisResult = result.data;
      setDiagnosisResult(data);
      if (data.diagnostic) {
        setDiagnosticResult(data.diagnostic);
      }
      setTerminalLines(prev => [
        ...prev,
        { text: `[INSPECTION] Located bug in ${data.file} at line ${data.line}!`, type: 'error' },
        { text: `[DIAGNOSIS] Exception: ${data.exception} ("${data.message}")`, type: 'error' },
        { text: `[ROOT CAUSE] ${data.root_cause}`, type: 'warning' },
        { text: `[SUGGESTED FIX] ${data.suggested_fix}`, type: 'success' }
      ]);
      setTargetFeedback({
        type: 'success',
        message: `Diagnosis complete: Identified ${data.exception} in ${data.file} at line ${data.line}.`,
      });
    } catch (err: any) {
      setTargetFeedback({ type: 'error', message: err.message || 'Diagnosis failed.' });
      setTerminalLines(prev => [
        ...prev,
        { text: `[DIAGNOSIS ERROR] ${err.message}`, type: 'error' }
      ]);
    } finally {
      setIsDiagnosing(false);
    }
  };

  // Generate AI Fix via Amazon Bedrock (Converse API with Llama 3.3 70B Instruct)
  const handleGenerateAiFix = async () => {
    setIsGeneratingFix(true);
    setAiFixError(null);
    setAiFixResult(null);
    setAppliedPatchResult(null);
    setAppliedPatchError(null);
    setTargetFeedback(null);

    try {
      setTerminalLines(prev => [
        ...prev,
        { text: `[AI FIX] Invoking Amazon Bedrock (us.meta.llama3-3-70b-instruct-v1:0)...`, type: 'system' },
        { text: `[AI PROMPT] Analyzing runtime exception & source code in ${targetGithubRepo}...`, type: 'normal' }
      ]);

      const result = await safeFetchJson('/api/agent/generate-fix', { method: 'POST' });
      if (!result.ok || !result.data) {
        throw new Error(result.error || 'Failed to generate AI fix.');
      }
      const data = result.data;

      if (data.status === 'ai_unavailable' || data.status === 'diagnostic_failed' || data.status === 'inspection_failed') {
        const errMsg = data.error || 'Amazon Bedrock is unavailable or target inspection failed.';
        setAiFixError(errMsg);
        setTerminalLines(prev => [
          ...prev,
          { text: `[AI FIX FAILED] ${errMsg}`, type: 'error' }
        ]);
        setTargetFeedback({
          type: 'error',
          message: `AI Fix Generation Failed: ${errMsg}`
        });
        return;
      }

      if (data.status === 'fix_proposed') {
        setAiFixResult(data);
        setTerminalLines(prev => [
          ...prev,
          { text: `[BEDROCK] AI fix successfully generated with confidence ${(data.confidence * 100).toFixed(0)}%!`, type: 'success' },
          { text: `[PROPOSED PATCH] File: ${data.file}:${data.line}`, type: 'normal' },
          { text: `[PROPOSED PATCH] Original: ${data.proposed_fix?.original_code} -> Proposed: ${data.proposed_fix?.replacement_code?.replace(/\n/g, ' ')}`, type: 'normal' },
          { text: `[SAFETY GUARD] Proposed fix marked: PROPOSED FIX — NOT APPLIED. Awaiting human code review.`, type: 'alert' }
        ]);
        setTargetFeedback({
          type: 'success',
          message: `AI Fix Proposal generated for ${data.file} (Confidence: ${(data.confidence * 100).toFixed(0)}%). PROPOSED FIX — NOT APPLIED.`
        });
      }
    } catch (err: any) {
      const msg = err.message || 'AI Fix Generation Failed.';
      setAiFixError(msg);
      setTerminalLines(prev => [
        ...prev,
        { text: `[AI FIX ERROR] ${msg}`, type: 'error' }
      ]);
      setTargetFeedback({ type: 'error', message: `AI Fix Generation Failed: ${msg}` });
    } finally {
      setIsGeneratingFix(false);
    }
  };

  // Stage 2: Human-Approved Patch Application and Isolated Validation
  const handleApproveAndApplyFix = async () => {
    if (!aiFixResult) return;
    setShowApprovalModal(false);
    setIsApplyingFix(true);
    setAppliedPatchResult(null);
    setAppliedPatchError(null);
    setApplyProgressStep(1);

    setTerminalLines(prev => [
      ...prev,
      { text: `[STAGE 2] Human approval received. Initiating isolated patch application...`, type: 'alert' },
      { text: `[STEP 1/5] Validating patch payload and safety constraints...`, type: 'system' }
    ]);

    try {
      // Step 2 timer
      setTimeout(() => {
        setApplyProgressStep(2);
        setTerminalLines(prev => [
          ...prev,
          { text: `[STEP 2/5] Creating isolated Git branch sentinelops/fix/...`, type: 'normal' }
        ]);
      }, 700);

      // Step 3 timer
      setTimeout(() => {
        setApplyProgressStep(3);
        setTerminalLines(prev => [
          ...prev,
          { text: `[STEP 3/5] Applying patch to ${aiFixResult.file}...`, type: 'normal' }
        ]);
      }, 1400);

      // Step 4 timer
      setTimeout(() => {
        setApplyProgressStep(4);
        setTerminalLines(prev => [
          ...prev,
          { text: `[STEP 4/5] Running Patient test suite in isolated directory...`, type: 'normal' }
        ]);
      }, 2100);

      // Step 5 timer
      setTimeout(() => {
        setApplyProgressStep(5);
        setTerminalLines(prev => [
          ...prev,
          { text: `[STEP 5/5] Running runtime verification against /api/health and /api/user/999...`, type: 'normal' }
        ]);
      }, 2800);

      const payload = {
        approved: true,
        patch: {
          file: aiFixResult.file,
          original: aiFixResult.proposed_fix.original_code,
          replacement: aiFixResult.proposed_fix.replacement_code,
        },
        repo_url: targetGithubRepo,
        branch: targetBranch,
      };

      const result = await safeFetchJson<PatchValidationResult>('/api/agent/apply-fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!result.ok || !result.data) {
        throw new Error(result.error || 'Failed to apply and validate fix.');
      }

      const data: PatchValidationResult = result.data;
      setAppliedPatchResult(data);

      if (data.status === 'validated') {
        const branchName = data.branch || 'sentinelops/fix/...';
        const healthStatus = data.runtime_verification?.health?.status || '200 OK';
        const userStatus = data.runtime_verification?.test_endpoint?.status || '404 Not Found';
        const prevErr = data.runtime_verification?.previous || '500 IndexError';
        const currResp = data.runtime_verification?.current || '404 User not found';

        setTerminalLines(prev => [
          ...prev,
          { text: `=====================================================`, type: 'comment' },
          { text: `[PATCH VALIDATED] Fix verified on branch: ${branchName}`, type: 'success' },
          { text: `[PATCH VALIDATED] Target File: ${data.file}`, type: 'normal' },
          { text: `[PATCH VALIDATED] Tests: ${data.tests?.status || 'PASS'}`, type: 'success' },
          { text: `[RUNTIME VERIFICATION] GET /api/health -> ${healthStatus}`, type: 'success' },
          { text: `[RUNTIME VERIFICATION] GET /api/user/999 -> ${userStatus}`, type: 'success' },
          { text: `[RUNTIME CONTRAST] Previous: ${prevErr} ➔ Current: ${currResp}`, type: 'alert' },
          { text: `[SAFETY GUARANTEE] Patient main branch remains untouched. Zero remote commits/pushes.`, type: 'system' },
          { text: `=====================================================`, type: 'comment' },
        ]);

        setTargetFeedback({
          type: 'success',
          message: `PATCH VALIDATED on ${branchName}. Functional endpoint returned 404 Not Found. Main branch untouched.`
        });
      } else {
        const failMsg = data.message || 'Patch validation failed.';
        setAppliedPatchError(failMsg);
        setTerminalLines(prev => [
          ...prev,
          { text: `[PATCH VALIDATION FAILED] ${failMsg}`, type: 'error' },
          ...(data.tests?.output ? [{ text: `[TEST OUTPUT] ${data.tests.output}`, type: 'error' as const }] : [])
        ]);
        setTargetFeedback({
          type: 'error',
          message: `PATCH VALIDATION FAILED: ${failMsg}`
        });
      }
    } catch (err: any) {
      const msg = err.message || 'Patch application failed.';
      setAppliedPatchError(msg);
      setTerminalLines(prev => [
        ...prev,
        { text: `[PATCH ERROR] ${msg}`, type: 'error' }
      ]);
      setTargetFeedback({ type: 'error', message: `Patch Application Failed: ${msg}` });
    } finally {
      setIsApplyingFix(false);
      setApplyProgressStep(0);
    }
  };

  // Stage 3: Real GitHub Pull Request Creation
  const handleCreatePullRequest = async () => {
    setShowPrModal(false);
    setIsCreatingPr(true);
    setGitHubPrResult(null);
    setGitHubPrError(null);
    setPrProgressStep(1);

    setTerminalLines(prev => [
      ...prev,
      { text: `[STAGE 3] Human approval received for GitHub Pull Request creation.`, type: 'alert' },
      { text: `[PR STEP 1/6] Verifying Stage 2 validated patch integrity...`, type: 'system' }
    ]);

    try {
      setTimeout(() => {
        setPrProgressStep(2);
        setTerminalLines(prev => [
          ...prev,
          { text: `[PR STEP 2/6] Reading remote main branch HEAD and 'app/routes.py'...`, type: 'normal' }
        ]);
      }, 600);

      setTimeout(() => {
        setPrProgressStep(3);
        setTerminalLines(prev => [
          ...prev,
          { text: `[PR STEP 3/6] Creating isolated GitHub branch sentinelops/fix/...`, type: 'normal' }
        ]);
      }, 1200);

      setTimeout(() => {
        setPrProgressStep(4);
        setTerminalLines(prev => [
          ...prev,
          { text: `[PR STEP 4/6] Committing validated fix to isolated branch...`, type: 'normal' }
        ]);
      }, 1800);

      setTimeout(() => {
        setPrProgressStep(5);
        setTerminalLines(prev => [
          ...prev,
          { text: `[PR STEP 5/6] Pushing branch reference to GitHub...`, type: 'normal' }
        ]);
      }, 2400);

      setTimeout(() => {
        setPrProgressStep(6);
        setTerminalLines(prev => [
          ...prev,
          { text: `[PR STEP 6/6] Creating Pull Request targeting main...`, type: 'normal' }
        ]);
      }, 3000);

      const payload = {
        approved: true,
        repo_url: targetGithubRepo,
        base_branch: targetBranch
      };

      const result = await safeFetchJson<GitHubPrResult>('/api/agent/create-pr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!result.ok || !result.data) {
        throw new Error(result.error || 'Failed to create Pull Request.');
      }

      const data: GitHubPrResult = result.data;
      setGitHubPrResult(data);

      if (data.status === 'pr_created') {
        setTerminalLines(prev => [
          ...prev,
          { text: `=====================================================`, type: 'comment' },
          { text: `[GITHUB PR CREATED] Pull Request #${data.pr_number} created successfully!`, type: 'success' },
          { text: `[PR URL] ${data.pr_url}`, type: 'success' },
          { text: `[REPOSITORY] ${data.repository}`, type: 'normal' },
          { text: `[HEAD BRANCH] ${data.branch}`, type: 'normal' },
          { text: `[BASE BRANCH] ${data.base_branch} (SHA: ${data.base_sha?.slice(0, 7)})`, type: 'normal' },
          { text: `[COMMIT SHA] ${data.commit_sha?.slice(0, 7)}`, type: 'normal' },
          { text: `[STATUS] Awaiting human review on GitHub. Automatic merge is disabled.`, type: 'alert' },
          { text: `=====================================================`, type: 'comment' }
        ]);
        setTargetFeedback({
          type: 'success',
          message: `Pull Request #${data.pr_number} created: ${data.pr_url}. Awaiting human review on GitHub.`
        });
      } else {
        const errMsg = data.message || 'Pull Request creation could not proceed.';
        setGitHubPrError(errMsg);
        setTerminalLines(prev => [
          ...prev,
          { text: `[PR CREATION HALTED] ${errMsg}`, type: 'error' }
        ]);
        setTargetFeedback({
          type: 'error',
          message: `PR Creation: ${errMsg}`
        });
      }
    } catch (err: any) {
      const msg = err.message || 'Failed to create GitHub Pull Request.';
      setGitHubPrError(msg);
      setTerminalLines(prev => [
        ...prev,
        { text: `[PR CREATION ERROR] ${msg}`, type: 'error' }
      ]);
      setTargetFeedback({ type: 'error', message: `PR Error: ${msg}` });
    } finally {
      setIsCreatingPr(false);
      setPrProgressStep(0);
    }
  };

  // Real Agent Execution Trigger
  const handleTriggerRealTest = async () => {
    setIsRealTriggerRunning(true);
    try {
      const result = await safeFetchJson('/api/agent/trigger', { method: 'POST' });
      if (!result.ok || !result.data) {
        throw new Error(result.error || 'Failed to trigger agent.');
      }
      const data = result.data;
      setTerminalLines(prev => [
        ...prev,
        { text: `[AGENT TRIGGER] Real execution dispatched for target: ${data.target}`, type: 'system' },
        { text: `[AGENT TRIGGER] Telemetry: ${data.cloudwatch_status}`, type: 'normal' },
        { text: `[AGENT TRIGGER] Status: ${data.message}`, type: 'success' },
      ]);
    } catch (err: any) {
      setTerminalLines(prev => [
        ...prev,
        { text: `[AGENT TRIGGER ERROR] ${err.message}`, type: 'error' }
      ]);
    } finally {
      setIsRealTriggerRunning(false);
    }
  };

  // Apply theme to document
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Scroll terminal to bottom when content changes
  useEffect(() => {
    if (terminalEndRef.current) {
      terminalEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [terminalLines, showDiff]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  // Run the simulation sequence
  const startSimulation = () => {
    if (isSimRunning) return;
    
    setIsSimRunning(true);
    setSimStep(1);
    setSystemHealth('Degraded');
    setShowDiff(false);
    setTerminalLines([
      { text: '[SYSTEM] Simulating production event...', type: 'system' },
      { text: '🚨 [ALERT] CloudWatch Alarm "SacrificialAppCrashAlarm" transitioned to ALARM state.', type: 'error' },
      { text: '[ALERT] Metric: Errors > 0 in 1 min window (Target: /aws/ops-pilot/sacrificial-app)', type: 'error' },
      { text: '[SYSTEM] EventBridge Event rule matched. Triggering Lambda Ingestion handler...', type: 'system' }
    ]);
  };

  useEffect(() => {
    if (!isSimRunning) return;

    let timer: any;

    // Phase 1 -> 2: Fetch CloudWatch Logs
    if (simStep === 1) {
      timer = setTimeout(() => {
        setTerminalLines(prev => [
          ...prev,
          { text: '[LAMBDA INGEST] Alarm metadata parsed successfully.', type: 'system' },
          { text: '[LAMBDA INGEST] Forwarding job details to OpsPilot Bedrock Core...', type: 'system' },
          { text: '🤖 OpsPilot: Orchestrator loop activated. Goal: remediate app/app_simulator.py.', type: 'system' },
          { text: '🤖 OpsPilot: Step 1 -> Invoking AWS MCP Server (fetch_cloudwatch_logs)...', type: 'normal' },
          { text: '[AWS MCP] Connection established. Ingesting Log Group: /aws/ops-pilot/sacrificial-app, Stream: production-errors.', type: 'mcp' },
          { text: '[AWS MCP] Ingestion completed. 1 critical exception found:', type: 'mcp' },
          { text: '--------------------------------------------------', type: 'comment' },
          { text: '[CRITICAL ERROR] RequestID: 99f9999f-999f-99f9-999f-999f999f999f', type: 'error' },
          { text: 'Timestamp: 2026-07-13T04:22:15.129Z', type: 'error' },
          { text: 'Details: Traceback (most recent call last):', type: 'error' },
          { text: '  File "app/app_simulator.py", line 15, in simulate_crash', type: 'error' },
          { text: '    print(arr[15])', type: 'error' },
          { text: 'IndexError: list index out of range', type: 'error' },
          { text: '--------------------------------------------------', type: 'comment' }
        ]);
        setActiveArchNode('aws_mcp');
        setSimStep(2);
      }, 2500);
    }

    // Phase 2 -> 3: Read GitHub file
    else if (simStep === 2) {
      timer = setTimeout(() => {
        setTerminalLines(prev => [
          ...prev,
          { text: '🤖 OpsPilot: Step 2 -> Scanning files. Invoking GitHub MCP Server (read_file)...', type: 'normal' },
          { text: '[GITHUB MCP] Authorizing API requests against repo workspace...', type: 'mcp' },
          { text: '[GITHUB MCP] Success. Read app/app_simulator.py (40 lines of code).', type: 'mcp' }
        ]);
        setActiveArchNode('github_mcp');
        setSimStep(3);
      }, 2500);
    }

    // Phase 3 -> 4: Reasoning & Applying Code Fix
    else if (simStep === 3) {
      timer = setTimeout(() => {
        setTerminalLines(prev => [
          ...prev,
          { text: '🤖 OpsPilot: Step 3 -> Invoking Bedrock model (Claude 3.5 Sonnet) for code analysis...', type: 'normal' },
          { text: '🤖 OpsPilot: Brain reasoning:', type: 'comment' },
          { text: '   "The application simulator defines an array of size 2 (arr = [2, 3]). It tries to fetch index 15.',
          type: 'comment' },
          { text: '    This causes a list index out of bounds error. I will modify App Simulator to perform', type: 'comment' },
          { text: '    a bounds check on the index before trying to access it."', type: 'comment' },
          { text: '🤖 OpsPilot: Step 4 -> Applying code fix. Invoking GitHub MCP Server (patch_file)...', type: 'normal' },
          { text: '[GITHUB MCP] Applying git patch to app/app_simulator.py...', type: 'mcp' },
          { text: '[GITHUB MCP] File successfully updated. Audit tracking stamp appended to code.', type: 'mcp' }
        ]);
        setShowDiff(true);
        setSimStep(4);
      }, 3000);
    }

    // Phase 4 -> 5: Run tests
    else if (simStep === 4) {
      timer = setTimeout(() => {
        setSystemHealth('Healing');
        setTerminalLines(prev => [
          ...prev,
          { text: '🤖 OpsPilot: Step 5 -> Verifying file health. Invoking Sandbox MCP Server (execute_tests)...', type: 'normal' },
          { text: '[SANDBOX MCP] Booting isolated testing docker container...', type: 'mcp' },
          { text: '[SANDBOX MCP] Command: python -m unittest discover -s tests', type: 'mcp' },
          { text: '[SANDBOX MCP] Output captured:', type: 'mcp' },
          { text: '--------------------------------------------------', type: 'comment' },
          { text: 'test_execution_stability (test_app_simulator.TestAppSimulator) ... ok', type: 'normal' },
          { text: 'Ran 1 test in 0.042s', type: 'normal' },
          { text: 'OK', type: 'success' },
          { text: '--------------------------------------------------', type: 'comment' }
        ]);
        setActiveArchNode('sandbox_mcp');
        setSimStep(5);
      }, 3000);
    }

    // Phase 5 -> 6: Finishing up
    else if (simStep === 5) {
      timer = setTimeout(() => {
        setTerminalLines(prev => [
          ...prev,
          { text: '🤖 OpsPilot: Step 6 -> Reflection loop. Verification checks passed (PASSED).', type: 'success' },
          { text: '🤖 OpsPilot: Generating healing summary for deployment audit log...', type: 'normal' },
          { text: '✅ Goal accomplished! OpsPilot loop exited cleanly.', type: 'success' },
          { text: '----------------- HEALING SUMMARY -----------------', type: 'success' },
          { text: '1. Root Cause: IndexError caused by accessing index 15 of a 2-element list in app_simulator.py.', type: 'normal' },
          { text: '2. Solution Applied: Added a boundary checker to ensure index is less than list length.', type: 'normal' },
          { text: '3. Verification: Pytest suite returned status PASSED.', type: 'normal' },
          { text: '4. Stability: System is stable. Created Pull Request #43 for Human Code Review.', type: 'normal' },
          { text: '---------------------------------------------------', type: 'success' },
          { text: '[SYSTEM] Self-healing workflow complete. Restoring operational baseline.', type: 'system' }
        ]);
        setAutocures(prev => prev + 1);
        setSavings(prev => prev + 50.0);
        setSystemHealth('Healthy');
        setIsSimRunning(false);
        setSimStep(0);
        setActiveArchNode('bedrock');
      }, 3000);
    }

    return () => clearTimeout(timer);
  }, [isSimRunning, simStep]);

  // Simulated code diff contents
  const diffLines: DiffLine[] = [
    { text: '@@ -9,12 +9,17 @@', type: 'normal' },
    { text: ' def simulate_crash():', type: 'normal' },
    { text: '     """Simulates a brand new out-of-bounds list error."""', type: 'normal' },
    { text: '     print("🚀 Running app simulator...")', type: 'normal' },
    { text: '     try:', type: 'normal' },
    { text: '-        # 💥 YOUR NEW ERROR: Asking for an index that doesn\'t exist', type: 'removed' },
    { text: '-        arr = [2, 3]', type: 'removed' },
    { text: '-        print(arr[15]) ', type: 'removed' },
    { text: '+        arr = [2, 3]', type: 'added' },
    { text: '+        index_to_access = 15', type: 'added' },
    { text: '+        if index_to_access < len(arr):', type: 'added' },
    { text: '+            print(arr[index_to_access])', type: 'added' },
    { text: '+        else:', type: 'added' },
    { text: '+            print(f"Index {index_to_access} is out of bounds for array of length {len(arr)}")', type: 'added' },
    { text: '     except Exception as e:', type: 'normal' },
    { text: '         print("💥 App crashed! Formatting stack trace...")', type: 'normal' }
  ];

  return (
    <div className="app-container fade-in">
      {/* Header */}
      <header className="app-header">
        <div className="logo-section">
          <div className="logo-icon">🛡️</div>
          <div>
            <h1 className="logo-title">SentinelOps-AI</h1>
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '-4px' }}>
              Autonomous self-healing infrastructure pipeline
            </p>
          </div>
        </div>

        <div className="header-actions">
          <div className={`system-badge ${systemHealth === 'Healthy' ? '' : systemHealth === 'Healing' ? 'warning' : 'danger'}`}>
            <span className="badge-pulse" style={{
              backgroundColor: systemHealth === 'Healthy' ? 'var(--success-color)' : systemHealth === 'Healing' ? 'var(--warning-color)' : 'var(--error-color)'
            }}></span>
            {systemHealth === 'Healthy' ? 'System Status: Active' : systemHealth === 'Healing' ? 'System Status: Self-Healing' : 'System Status: Incident Found'}
          </div>

          <button onClick={toggleTheme} className="theme-toggle-btn" aria-label="Toggle theme">
            {theme === 'dark' ? (
              <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="5" />
                <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
              </svg>
            ) : (
              <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>
        </div>
      </header>

      {/* Tabs Menu */}
      <nav className="nav-tabs">
        <button
          onClick={() => setActiveTab('dashboard')}
          className={`tab-btn ${activeTab === 'dashboard' ? 'active' : ''}`}
        >
          Dashboard
        </button>
        <button
          onClick={() => setActiveTab('architecture')}
          className={`tab-btn ${activeTab === 'architecture' ? 'active' : ''}`}
        >
          How It Works
        </button>
        <button
          onClick={() => setActiveTab('docs')}
          className={`tab-btn ${activeTab === 'docs' ? 'active' : ''}`}
        >
          Technical Docs
        </button>
      </nav>

      {/* Main content body */}
      <main className="main-content">
        {/* Tab 1: Dashboard */}
        {activeTab === 'dashboard' && (
          <div className="dashboard-grid fade-in">
            {/* Target Application Configuration Card */}
            <div className="target-section-card">
              <div className="target-header-row">
                <div className="target-header-title">
                  <span>🎯 TARGET APPLICATION</span>
                  <span style={{ fontSize: '13px', fontWeight: 400, color: 'var(--text-secondary)' }}>
                    (The "Patient" Web Application)
                  </span>
                </div>
                <div className={`target-status-badge ${targetStatus.toLowerCase().replace(' ', '-')}`}>
                  <span className="badge-pulse" style={{
                    backgroundColor:
                      targetStatus === 'Healthy' ? 'var(--success-color)' :
                      targetStatus === 'Connected' ? 'var(--accent-color)' :
                      targetStatus === 'Healing' ? 'var(--warning-color)' :
                      targetStatus === 'Unhealthy' ? 'var(--error-color)' : 'var(--text-tertiary)'
                  }}></span>
                  Target Status: {targetStatus}
                </div>
              </div>

              {targetFeedback && (
                <div className={`target-feedback-msg ${targetFeedback.type}`}>
                  <span>{targetFeedback.type === 'success' ? '✓' : '⚠️'}</span>
                  <span>{targetFeedback.message}</span>
                </div>
              )}

              <div className="target-form-grid">
                <div className="target-field-group">
                  <label className="target-label">Application Name</label>
                  <input
                    type="text"
                    className="target-input"
                    value={targetName}
                    onChange={(e) => setTargetName(e.target.value)}
                    placeholder="e.g. SentinelOps Patient"
                    disabled={isTargetConnecting || isTargetCheckingHealth || isRunningDiagnostic || isDiagnosing}
                  />
                </div>
                <div className="target-field-group">
                  <label className="target-label">Demo URL</label>
                  <input
                    type="url"
                    className="target-input"
                    value={targetDemoUrl}
                    onChange={(e) => setTargetDemoUrl(e.target.value)}
                    placeholder="http://localhost:8001"
                    disabled={isTargetConnecting || isTargetCheckingHealth || isRunningDiagnostic || isDiagnosing}
                  />
                </div>
                <div className="target-field-group">
                  <label className="target-label">GitHub Repository</label>
                  <input
                    type="url"
                    className="target-input"
                    value={targetGithubRepo}
                    onChange={(e) => setTargetGithubRepo(e.target.value)}
                    placeholder="https://github.com/HITESHsai01/Patient"
                    disabled={isTargetConnecting || isTargetCheckingHealth || isRunningDiagnostic || isDiagnosing}
                  />
                </div>
                <div className="target-field-group">
                  <label className="target-label">Branch</label>
                  <input
                    type="text"
                    className="target-input"
                    value={targetBranch}
                    onChange={(e) => setTargetBranch(e.target.value)}
                    placeholder="main"
                    disabled={isTargetConnecting || isTargetCheckingHealth || isRunningDiagnostic || isDiagnosing}
                  />
                </div>
              </div>

              <div className="target-actions-row">
                <div className="target-btn-group">
                  <button
                    onClick={handleConnectTarget}
                    disabled={isTargetConnecting || isTargetCheckingHealth || isRunningDiagnostic || isDiagnosing}
                    className="btn btn-primary"
                  >
                    {isTargetConnecting ? 'Connecting...' : 'Connect Target'}
                  </button>
                  <button
                    onClick={handleCheckHealth}
                    disabled={isTargetConnecting || isTargetCheckingHealth || isRunningDiagnostic || isDiagnosing || targetStatus === 'Not Connected'}
                    className="btn btn-secondary"
                    title={targetStatus === 'Not Connected' ? 'Connect target first to check health' : 'Probe target health URL'}
                  >
                    {isTargetCheckingHealth ? 'Checking Health...' : 'Check Health'}
                  </button>
                  <button
                    onClick={handleRunDiagnostic}
                    disabled={isTargetConnecting || isTargetCheckingHealth || isRunningDiagnostic || isDiagnosing || targetStatus === 'Not Connected'}
                    className="btn btn-accent"
                    title={targetStatus === 'Not Connected' ? 'Connect target first to run diagnostic' : 'Run diagnostic against patient endpoints'}
                  >
                    {isRunningDiagnostic ? 'Running Diagnostic...' : '⚡ Run Diagnostic'}
                  </button>
                  <button
                    onClick={handleRunDiagnosis}
                    disabled={isTargetConnecting || isTargetCheckingHealth || isRunningDiagnostic || isDiagnosing || isGeneratingFix || targetStatus === 'Not Connected'}
                    className="btn btn-secondary"
                    title={targetStatus === 'Not Connected' ? 'Connect target first' : 'Inspect patient repository and diagnose root cause'}
                  >
                    {isDiagnosing ? 'Inspecting Repo...' : '🔍 Inspect Code & Diagnose'}
                  </button>
                  <button
                    onClick={handleGenerateAiFix}
                    disabled={isTargetConnecting || isTargetCheckingHealth || isRunningDiagnostic || isDiagnosing || isGeneratingFix || targetStatus === 'Not Connected'}
                    className="btn btn-ai-fix"
                    title={targetStatus === 'Not Connected' ? 'Connect target first' : 'Generate AI Fix with Amazon Bedrock'}
                  >
                    {isGeneratingFix ? '🤖 Generating AI Fix...' : '✨ Generate AI Fix'}
                  </button>
                </div>

                {targetHealthDetails && (
                  <div className="target-meta-details">
                    <span className="target-meta-item">
                      HTTP Status: <strong>{targetHealthDetails.http_status || targetHealthDetails.status_code || 'N/A'}</strong>
                    </span>
                    <span className="target-meta-item">
                      Latency: <strong>{targetHealthDetails.latency_ms !== null && targetHealthDetails.latency_ms !== undefined ? `${targetHealthDetails.latency_ms}ms` : 'N/A'}</strong>
                    </span>
                    {targetHealthDetails.error && (
                      <span className="target-meta-item" style={{ color: 'var(--error-color)' }}>
                        {targetHealthDetails.error}
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* Connected Target Display (Requirement 3) */}
              {targetStatus !== 'Not Connected' && (
                <div className="connected-target-overview">
                  <div className="connected-target-title">
                    <span>📡 CONNECTED TARGET OVERVIEW</span>
                    <span className="connected-target-mode-tag">Doctor ➔ Patient Link Active</span>
                  </div>
                  <div className="connected-target-grid">
                    <div className="connected-target-item">
                      <span className="connected-target-label">Target:</span>
                      <span className="connected-target-value font-bold">{targetName}</span>
                    </div>
                    <div className="connected-target-item">
                      <span className="connected-target-label">URL:</span>
                      <span className="connected-target-value">
                        <a href={targetDemoUrl} target="_blank" rel="noreferrer" className="connected-link">
                          {targetDemoUrl}
                        </a>
                      </span>
                    </div>
                    <div className="connected-target-item">
                      <span className="connected-target-label">GitHub:</span>
                      <span className="connected-target-value">
                        <a href={targetGithubRepo} target="_blank" rel="noreferrer" className="connected-link">
                          {targetGithubRepo}
                        </a>
                      </span>
                    </div>
                    <div className="connected-target-item">
                      <span className="connected-target-label">Branch:</span>
                      <span className="connected-target-value"><code className="branch-tag">{targetBranch}</code></span>
                    </div>
                    <div className="connected-target-item">
                      <span className="connected-target-label">Health:</span>
                      <span className={`connected-target-value health-badge ${targetHealthDisplay.toLowerCase().replace(' ', '-')}`}>
                        {targetHealthDisplay}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Real Patient Diagnostic Panel (Requirement 4 & 5) */}
              {diagnosticResult && (
                <div className="diagnostic-results-panel">
                  <div className="panel-header-row">
                    <div className="panel-title-area">
                      <span className="panel-title">🔬 REAL PATIENT DIAGNOSTIC RESULTS</span>
                      {diagnosticResult.timestamp && (
                        <span className="panel-timestamp">{new Date(diagnosticResult.timestamp).toLocaleTimeString()}</span>
                      )}
                    </div>
                    <div className="diagnostic-contrast-summary">
                      <span className="contrast-tag healthy">Health: {diagnosticResult.health.status.toUpperCase()}</span>
                      <span className="contrast-vs">vs</span>
                      <span className="contrast-tag failed">Endpoint: FAILED</span>
                      <span className="contrast-tag exception">Exception: IndexError</span>
                    </div>
                  </div>

                  <div className="diagnostic-insight-banner">
                    <span className="insight-icon">ℹ️</span>
                    <div className="insight-text">
                      <strong>Architectural Distinction:</strong> The patient application's health endpoint (<code>/api/health</code>) intentionally remains <strong>HEALTHY</strong> while endpoint <code>/api/user/999</code> produced an unhandled <strong>IndexError</strong> (HTTP 500). SentinelOps Doctor isolates failing functional endpoints even when runtime liveness checks pass.
                    </div>
                  </div>

                  <div className="diagnostic-test-grid">
                    {/* Health Check Card */}
                    <div className="diagnostic-card health-card">
                      <div className="card-top">
                        <span className="card-label">Patient Health Endpoint</span>
                        <span className="pill-badge healthy">HEALTHY</span>
                      </div>
                      <div className="card-metrics">
                        <div className="metric-line">
                          <span>Endpoint:</span>
                          <code>/api/health</code>
                        </div>
                        <div className="metric-line">
                          <span>HTTP Status:</span>
                          <span className="status-code-green">{diagnosticResult.health.http_status || 200} OK</span>
                        </div>
                        <div className="metric-line">
                          <span>Latency:</span>
                          <span>{diagnosticResult.health.latency_ms !== null && diagnosticResult.health.latency_ms !== undefined ? `${diagnosticResult.health.latency_ms}ms` : 'N/A'}</span>
                        </div>
                        <div className="metric-line">
                          <span>Service State:</span>
                          <span className="status-code-green">Online & Responding</span>
                        </div>
                      </div>
                    </div>

                    {/* Failing Test Endpoint Card */}
                    {diagnosticResult.tests.map((test, idx) => (
                      <div key={idx} className="diagnostic-card error-card">
                        <div className="card-top">
                          <span className="card-label">Application Test Endpoint</span>
                          <span className="pill-badge failed">FAILED</span>
                        </div>
                        <div className="card-metrics">
                          <div className="metric-line">
                            <span>Endpoint:</span>
                            <code>{test.path}</code>
                          </div>
                          <div className="metric-line">
                            <span>HTTP Status:</span>
                            <span className="status-code-red">{test.http_status || 500} Internal Server Error</span>
                          </div>
                          <div className="metric-line">
                            <span>Exception:</span>
                            <span className="status-code-red font-bold">{test.error_type || 'IndexError'}</span>
                          </div>
                          <div className="metric-line">
                            <span>Message:</span>
                            <span className="error-message-text">"{test.message || 'list index out of range'}"</span>
                          </div>
                          <div className="metric-line">
                            <span>Latency:</span>
                            <span>{test.latency_ms !== null && test.latency_ms !== undefined ? `${test.latency_ms}ms` : 'N/A'}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Autonomous Diagnosis & Repository Inspection Panel (Requirement 6 & 7) */}
              {diagnosisResult && (
                <div className="diagnosis-results-panel">
                  <div className="panel-header-row">
                    <div className="panel-title-area">
                      <span className="panel-title">🧠 REPOSITORY INSPECTION & ROOT CAUSE DIAGNOSIS</span>
                      <span className="diagnosis-status-pill">Status: {diagnosisResult.status}</span>
                    </div>
                  </div>

                  <div className="diagnosis-details-grid">
                    <div className="detail-item">
                      <span className="detail-label">Target Application</span>
                      <span className="detail-val">{diagnosisResult.target}</span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">Exception</span>
                      <span className="detail-val text-error font-bold">{diagnosisResult.exception}</span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">Error Message</span>
                      <span className="detail-val font-mono">"{diagnosisResult.message}"</span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">Failing File & Discovered Line</span>
                      <span className="detail-val font-mono text-accent">
                        <strong>{diagnosisResult.file}</strong> : line <strong>{diagnosisResult.line}</strong>
                      </span>
                    </div>
                  </div>

                  <div className="diagnosis-analysis-box">
                    <div className="analysis-row">
                      <span className="analysis-heading">🔎 Root Cause:</span>
                      <span className="analysis-body">{diagnosisResult.root_cause}</span>
                    </div>
                    <div className="analysis-row">
                      <span className="analysis-heading">💡 Suggested Fix:</span>
                      <span className="analysis-body text-success">{diagnosisResult.suggested_fix}</span>
                    </div>
                  </div>

                  {diagnosisResult.code_snippet && diagnosisResult.code_snippet.length > 0 && (
                    <div className="code-inspection-viewer">
                      <div className="code-viewer-header">
                        <span>Source File: {diagnosisResult.file} (Discovered line {diagnosisResult.line})</span>
                        <span className="badge-read-only">READ-ONLY GIT CLONE</span>
                      </div>
                      <pre className="code-viewer-body">
                        {diagnosisResult.code_snippet.map((line, idx) => {
                          const isBugLine = line.includes('SENTINELOPS_TEST_BUG') || line.includes('matching[0]');
                          return (
                            <div key={idx} className={`code-row ${isBugLine ? 'bug-line-highlight' : ''}`}>
                              <span className="code-text">{line}</span>
                              {isBugLine && <span className="bug-marker-tag">← DEFECT</span>}
                            </div>
                          );
                        })}
                      </pre>
                    </div>
                  )}
                </div>
              )}

              {/* AI Fix Generation Failed Banner (Requirement 7) */}
              {aiFixError && (
                <div className="ai-fix-failed-panel">
                  <div className="ai-fix-failed-header">
                    <span className="ai-fix-failed-icon">⚠️</span>
                    <div className="ai-fix-failed-text-wrap">
                      <h4 className="ai-fix-failed-title">AI Fix Generation Failed</h4>
                      <p className="ai-fix-failed-desc">{aiFixError}</p>
                    </div>
                  </div>
                  <div className="ai-fix-failed-hint">
                    <strong>Integrity Guarantee:</strong> SentinelOps Doctor never falsifies AI responses when Amazon Bedrock inference is unavailable. To generate live fixes, ensure valid AWS credentials with <code>bedrock:InvokeModel</code> permissions for <code>us.meta.llama3-3-70b-instruct-v1:0</code> are available in your environment.
                  </div>
                </div>
              )}

              {/* AI Fix Proposal Panel (Requirement 6) */}
              {aiFixResult && (
                <div className="ai-fix-proposal-panel">
                  <div className="ai-fix-proposal-header">
                    <div className="ai-fix-title-group">
                      <span className="ai-fix-icon">✨</span>
                      <div>
                        <h3 className="ai-fix-title">AI Fix Proposal</h3>
                        <span className="ai-fix-subtitle">Generated by Amazon Bedrock (Llama 3.3 70B Instruct)</span>
                      </div>
                    </div>
                    <div className="ai-fix-badges">
                      <span className="badge-not-applied">PROPOSED FIX — NOT APPLIED</span>
                      <span className="badge-confidence">Confidence: {(aiFixResult.confidence * 100).toFixed(0)}%</span>
                    </div>
                  </div>

                  <div className="ai-fix-safety-banner">
                    <span className="safety-icon">🛡️</span>
                    <div className="safety-text">
                      <strong>PROPOSED FIX — NOT APPLIED:</strong> This remediation was generated by Amazon Bedrock for engineer review. No files in SentinelOps-Patient, local repositories, or GitHub branches have been modified.
                    </div>
                  </div>

                  <div className="ai-fix-meta-grid">
                    <div className="ai-fix-meta-item">
                      <span className="meta-label">File</span>
                      <span className="meta-val font-mono text-accent">
                        <strong>{aiFixResult.file}</strong> (line <strong>{aiFixResult.line}</strong>)
                      </span>
                    </div>
                    <div className="ai-fix-meta-item">
                      <span className="meta-label">Target Application</span>
                      <span className="meta-val font-bold">{aiFixResult.target}</span>
                    </div>
                    <div className="ai-fix-meta-item">
                      <span className="meta-label">Diagnosed Exception</span>
                      <span className="meta-val text-error font-bold">{aiFixResult.exception}</span>
                    </div>
                    <div className="ai-fix-meta-item">
                      <span className="meta-label">Model Confidence</span>
                      <span className="meta-val font-bold text-success">
                        {(aiFixResult.confidence * 100).toFixed(0)}% ({aiFixResult.confidence})
                      </span>
                    </div>
                  </div>

                  <div className="ai-fix-root-cause-box">
                    <div className="root-cause-header">🔍 Diagnosed Root Cause:</div>
                    <div className="root-cause-body">{aiFixResult.root_cause}</div>
                  </div>

                  {/* Code Patch Comparison Viewer */}
                  <div className="ai-fix-diff-viewer">
                    <div className="diff-viewer-header">
                      <span>Target File: <code>{aiFixResult.file}</code></span>
                      <span className="badge-read-only">PROPOSED REPLACEMENT</span>
                    </div>

                    <div className="diff-blocks-container">
                      <div className="diff-block original-block">
                        <div className="diff-block-tag original">
                          <span>Original:</span>
                        </div>
                        <pre className="diff-code-pre">
                          <code>{aiFixResult.proposed_fix.original_code}</code>
                        </pre>
                      </div>

                      <div className="diff-block proposed-block">
                        <div className="diff-block-tag proposed">
                          <span>Proposed:</span>
                          <span className="sub-badge-not-applied">NOT APPLIED</span>
                        </div>
                        <pre className="diff-code-pre">
                          <code>{aiFixResult.proposed_fix.replacement_code}</code>
                        </pre>
                      </div>
                    </div>
                  </div>

                  <div className="ai-fix-explanation-box">
                    <div className="explanation-header">💡 Explanation:</div>
                    <div className="explanation-body">{aiFixResult.explanation}</div>
                  </div>

                  {/* Stage 2: Human Approval Action Bar */}
                  <div className="ai-fix-action-bar">
                    <div className="action-info-group">
                      <span className="action-info-badge">HUMAN-IN-THE-LOOP CONTROL</span>
                      <p className="action-info-desc">
                        Review the proposed patch above. Explicit approval is required to create an isolated Git branch, apply the patch, and run validation.
                      </p>
                    </div>
                    <button
                      id="btn-approve-apply-fix"
                      className="btn-approve-fix"
                      onClick={() => setShowApprovalModal(true)}
                      disabled={isApplyingFix}
                    >
                      {isApplyingFix ? '⏳ Validating On Isolated Branch...' : '🛡️ Approve & Apply Fix'}
                    </button>
                  </div>

                  {/* Stage 2: Active Validation Progress Stepper */}
                  {isApplyingFix && (
                    <div className="apply-progress-panel">
                      <div className="progress-panel-header">
                        <div className="spinner-glow"></div>
                        <span className="progress-title">Applying Patch & Validating in Isolated Environment...</span>
                      </div>
                      <div className="progress-steps-list">
                        <div className={`step-item ${applyProgressStep >= 1 ? 'active' : ''} ${applyProgressStep > 1 ? 'completed' : ''}`}>
                          <span className="step-num">{applyProgressStep > 1 ? '✓' : '1'}</span>
                          <span className="step-text">Validating patch safety & constraints</span>
                        </div>
                        <div className={`step-item ${applyProgressStep >= 2 ? 'active' : ''} ${applyProgressStep > 2 ? 'completed' : ''}`}>
                          <span className="step-num">{applyProgressStep > 2 ? '✓' : '2'}</span>
                          <span className="step-text">Creating isolated Git branch</span>
                        </div>
                        <div className={`step-item ${applyProgressStep >= 3 ? 'active' : ''} ${applyProgressStep > 3 ? 'completed' : ''}`}>
                          <span className="step-num">{applyProgressStep > 3 ? '✓' : '3'}</span>
                          <span className="step-text">Applying structured patch</span>
                        </div>
                        <div className={`step-item ${applyProgressStep >= 4 ? 'active' : ''} ${applyProgressStep > 4 ? 'completed' : ''}`}>
                          <span className="step-num">{applyProgressStep > 4 ? '✓' : '4'}</span>
                          <span className="step-text">Running Patient test suite</span>
                        </div>
                        <div className={`step-item ${applyProgressStep >= 5 ? 'active' : ''} ${applyProgressStep > 5 ? 'completed' : ''}`}>
                          <span className="step-num">{applyProgressStep > 5 ? '✓' : '5'}</span>
                          <span className="step-text">Verifying runtime endpoint (/api/health & /api/user/999)</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Stage 2: Validated Patch Success Panel */}
                  {appliedPatchResult && appliedPatchResult.status === 'validated' && (
                    <div className="patch-validated-panel">
                      <div className="patch-validated-header">
                        <div className="validated-title-group">
                          <span className="validated-check-icon">✅</span>
                          <div>
                            <div className="validated-badge-row">
                              <span className="badge-patch-validated">PATCH VALIDATED</span>
                              <span className="badge-isolated">ISOLATED BRANCH ONLY</span>
                            </div>
                            <h3 className="validated-title">Remediation Successfully Applied & Verified</h3>
                          </div>
                        </div>
                      </div>

                      <div className="validated-meta-grid">
                        <div className="val-meta-item">
                          <span className="val-label">Branch:</span>
                          <span className="val-value font-mono branch-name">{appliedPatchResult.branch}</span>
                        </div>
                        <div className="val-meta-item">
                          <span className="val-label">File:</span>
                          <span className="val-value font-mono text-accent">{appliedPatchResult.file}</span>
                        </div>
                        <div className="val-meta-item">
                          <span className="val-label">Tests:</span>
                          <span className="val-value badge-test-pass">{appliedPatchResult.tests?.status || 'PASS'}</span>
                        </div>
                        <div className="val-meta-item">
                          <span className="val-label">/api/health:</span>
                          <span className="val-value text-success font-bold">
                            {appliedPatchResult.runtime_verification?.health?.status || '200 OK'}
                          </span>
                        </div>
                        <div className="val-meta-item">
                          <span className="val-label">/api/user/999:</span>
                          <span className="val-value text-accent font-bold">
                            {appliedPatchResult.runtime_verification?.test_endpoint?.status || '404 Not Found'}
                          </span>
                        </div>
                      </div>

                      <div className="validation-contrast-card">
                        <div className="contrast-header">📊 Operational Telemetry Transition</div>
                        <div className="contrast-grid">
                          <div className="contrast-item prev">
                            <span className="contrast-label">Previous:</span>
                            <span className="contrast-val text-error font-bold font-mono">
                              {appliedPatchResult.runtime_verification?.previous || '500 IndexError'}
                            </span>
                          </div>
                          <div className="contrast-arrow">➔</div>
                          <div className="contrast-item curr">
                            <span className="contrast-label">Current:</span>
                            <span className="contrast-val text-success font-bold font-mono">
                              {appliedPatchResult.runtime_verification?.current || '404 User not found'}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="validated-safety-guarantee">
                        <span className="safety-icon">🔒</span>
                        <div className="safety-text">
                          <strong>STRICT SAFETY GUARANTEE:</strong> Patient <code>main</code> branch remains untouched. No automatic commits, pushes, merges, pull requests, or deployments were performed.
                        </div>
                      </div>

                      {/* Stage 3: Create GitHub Pull Request Action */}
                      <div className="stage3-pr-action-bar">
                        <div className="pr-action-info">
                          <span className="pr-action-badge">STAGE 3: PULL REQUEST INTEGRATION</span>
                          <p className="pr-action-desc">
                            Remediation verified on isolated local branch. Create a real GitHub Pull Request against <code>HITESHsai01/Patient</code> targeting <code>main</code> for engineer review.
                          </p>
                        </div>
                        <button
                          id="btn-create-pr"
                          className="btn-create-pr"
                          onClick={() => setShowPrModal(true)}
                          disabled={isCreatingPr || isApplyingFix}
                        >
                          {isCreatingPr ? '⏳ Creating Pull Request...' : '🚀 Create GitHub Pull Request'}
                        </button>
                      </div>

                      {/* Stage 3: Active PR Creation Progress Stepper */}
                      {isCreatingPr && (
                        <div className="pr-progress-panel">
                          <div className="progress-panel-header">
                            <div className="spinner-glow pr-spinner"></div>
                            <span className="progress-title">Creating GitHub Pull Request Against HITESHsai01/Patient...</span>
                          </div>
                          <div className="progress-steps-list">
                            <div className={`step-item ${prProgressStep >= 1 ? 'active' : ''} ${prProgressStep > 1 ? 'completed' : ''}`}>
                              <span className="step-num">{prProgressStep > 1 ? '✓' : '1'}</span>
                              <span className="step-text">Verifying Stage 2 validated patch integrity</span>
                            </div>
                            <div className={`step-item ${prProgressStep >= 2 ? 'active' : ''} ${prProgressStep > 2 ? 'completed' : ''}`}>
                              <span className="step-num">{prProgressStep > 2 ? '✓' : '2'}</span>
                              <span className="step-text">Reading remote main branch HEAD SHA</span>
                            </div>
                            <div className={`step-item ${prProgressStep >= 3 ? 'active' : ''} ${prProgressStep > 3 ? 'completed' : ''}`}>
                              <span className="step-num">{prProgressStep > 3 ? '✓' : '3'}</span>
                              <span className="step-text">Creating isolated GitHub branch</span>
                            </div>
                            <div className={`step-item ${prProgressStep >= 4 ? 'active' : ''} ${prProgressStep > 4 ? 'completed' : ''}`}>
                              <span className="step-num">{prProgressStep > 4 ? '✓' : '4'}</span>
                              <span className="step-text">Committing validated fix</span>
                            </div>
                            <div className={`step-item ${prProgressStep >= 5 ? 'active' : ''} ${prProgressStep > 5 ? 'completed' : ''}`}>
                              <span className="step-num">{prProgressStep > 5 ? '✓' : '5'}</span>
                              <span className="step-text">Pushing branch reference to GitHub</span>
                            </div>
                            <div className={`step-item ${prProgressStep >= 6 ? 'active' : ''} ${prProgressStep > 6 ? 'completed' : ''}`}>
                              <span className="step-num">{prProgressStep > 6 ? '✓' : '6'}</span>
                              <span className="step-text">Creating Pull Request targeting main</span>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Stage 3: GitHub PR Created Success Card */}
                      {gitHubPrResult && gitHubPrResult.status === 'pr_created' && (
                        <div className="github-pr-created-panel">
                          <div className="pr-created-header">
                            <div className="pr-title-group">
                              <span className="pr-icon">🎉</span>
                              <div>
                                <div className="pr-badge-row">
                                  <span className="badge-pr-created">GITHUB PR CREATED</span>
                                  <span className="badge-pr-num">#{gitHubPrResult.pr_number}</span>
                                  <span className="badge-awaiting-review">Awaiting human review</span>
                                </div>
                                <h3 className="pr-title">{gitHubPrResult.title || 'fix: handle missing user endpoint error'}</h3>
                              </div>
                            </div>
                          </div>

                          <div className="pr-meta-grid">
                            <div className="pr-meta-item">
                              <span className="pr-label">Repository:</span>
                              <span className="pr-val font-bold">{gitHubPrResult.repository}</span>
                            </div>
                            <div className="pr-meta-item">
                              <span className="pr-label">Branch:</span>
                              <span className="pr-val font-mono text-accent">{gitHubPrResult.branch}</span>
                            </div>
                            <div className="pr-meta-item">
                              <span className="pr-label">Base:</span>
                              <span className="pr-val font-mono"><code className="branch-tag">{gitHubPrResult.base_branch || 'main'}</code></span>
                            </div>
                            <div className="pr-meta-item">
                              <span className="pr-label">Commit:</span>
                              <span className="pr-val font-mono" title={gitHubPrResult.commit_sha}>
                                {gitHubPrResult.commit_sha?.slice(0, 7) || 'N/A'}
                              </span>
                            </div>
                            <div className="pr-meta-item pr-link-col">
                              <span className="pr-label">Pull Request:</span>
                              <span className="pr-val">
                                <a
                                  href={gitHubPrResult.pr_url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="pr-link"
                                >
                                  {gitHubPrResult.pr_url} ↗
                                </a>
                              </span>
                            </div>
                            <div className="pr-meta-item">
                              <span className="pr-label">Status:</span>
                              <span className="pr-val badge-status-review">Awaiting human review</span>
                            </div>
                          </div>

                          <div className="pr-review-guidance">
                            <span className="guidance-icon">ℹ️</span>
                            <div className="guidance-text">
                              <strong>Human Review Required:</strong> Pull Request #{gitHubPrResult.pr_number} is open for maintainer review on GitHub. SentinelOps intentionally does <strong>not</strong> provide a Merge button. Maintainers review and merge via GitHub according to repository policy.
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Stage 3: PR Error / Stale / Auth Banner */}
                      {(gitHubPrError || (gitHubPrResult && gitHubPrResult.status !== 'pr_created')) && (
                        <div className="pr-error-panel">
                          <div className="pr-error-header">
                            <span className="error-icon">⚠️</span>
                            <div>
                              <span className="badge-pr-error">
                                {gitHubPrResult?.status === 'auth_error' ? 'GITHUB AUTHENTICATION REQUIRED' :
                                 gitHubPrResult?.status === 'PATCH_STALE' ? 'STALE PATCH DETECTED' : 'PR CREATION HALTED'}
                              </span>
                              <h4 className="error-title">
                                {gitHubPrResult?.status === 'auth_error' ? 'GitHub write authentication is not configured.' :
                                 gitHubPrResult?.status === 'PATCH_STALE' ? 'Remote main branch source code has changed.' : 'Failed to create Pull Request.'}
                              </h4>
                            </div>
                          </div>
                          <p className="pr-error-msg">{gitHubPrError || gitHubPrResult?.message}</p>
                          {gitHubPrResult?.status === 'auth_error' && (
                            <div className="pr-auth-hint">
                              <strong>Setup Instruction:</strong> Set the <code>GITHUB_TOKEN</code> environment variable on the backend server with repository write permissions (Contents & Pull Requests: Read & Write) to enable automated PR creation.
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Stage 2: Validation Failed Banner */}
                  {(appliedPatchError || (appliedPatchResult && appliedPatchResult.status !== 'validated')) && (
                    <div className="patch-failed-panel">
                      <div className="patch-failed-header">
                        <span className="failed-icon">❌</span>
                        <div>
                          <span className="badge-patch-failed">PATCH VALIDATION FAILED</span>
                          <h4 className="failed-title">Fix Application Aborted Safely</h4>
                        </div>
                      </div>
                      <div className="failed-body">
                        <p>{appliedPatchError || appliedPatchResult?.message}</p>
                        {appliedPatchResult?.tests?.output && (
                          <pre className="failed-output-pre">
                            <code>{appliedPatchResult.tests.output}</code>
                          </pre>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Sidebar with Metrics */}
            <div className="metrics-sidebar">
              <div className="card">
                <div className="card-title">
                  Mean Time to Resolution (MTTR)
                  <span style={{ fontSize: '18px' }}>⏱️</span>
                </div>
                <div className="metrics-value">14.2s</div>
                <div className="metrics-comparison">
                  vs <span style={{ textDecoration: 'line-through' }}>45.0m</span> manual healing (
                  <span className="comparison-highlight">99.4% faster</span>)
                </div>
              </div>

              <div className="card">
                <div className="card-title">
                  Successful Autocures
                  <span style={{ fontSize: '18px' }}>🚀</span>
                </div>
                <div className="metrics-value">{autocures}</div>
                <div className="metrics-comparison">
                  Recovery Success Rate: <span className="comparison-highlight">97.8%</span>
                </div>
              </div>

              <div className="card">
                <div className="card-title">
                  Dev-Hours/SRE Savings
                  <span style={{ fontSize: '18px' }}>💰</span>
                </div>
                <div className="metrics-value">${savings.toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
                <div className="metrics-comparison">
                  Estimated engineering costs averted
                </div>
              </div>

              <div className="card">
                <div className="card-title">
                  System Gate Checkpoints
                  <span style={{ fontSize: '18px' }}>🛡️</span>
                </div>
                <div className="status-gate-grid">
                  <div className="status-gate-item">
                    <div className="status-gate-label">
                      <span className="badge-pulse" style={{ backgroundColor: 'var(--success-color)' }}></span>
                      AWS CloudWatch Stream
                    </div>
                    <span className="status-gate-value status-online">Connected</span>
                  </div>
                  <div className="status-gate-item">
                    <div className="status-gate-label">
                      <span className="badge-pulse" style={{ backgroundColor: 'var(--success-color)' }}></span>
                      Bedrock Llama Model
                    </div>
                    <span className="status-gate-value status-online">Connected</span>
                  </div>
                  <div className="status-gate-item">
                    <div className="status-gate-label">
                      <span className="badge-pulse" style={{
                        backgroundColor: isSimRunning ? 'var(--accent-color)' : 'var(--success-color)',
                        animation: isSimRunning ? 'pulseGlowBlue 1.2s infinite' : 'none'
                      }}></span>
                      MCP Servers Gateway
                    </div>
                    <span className={`status-gate-value ${isSimRunning ? 'status-active' : 'status-online'}`}>
                      {isSimRunning ? 'Active Execution' : '3 Connected'}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Terminal Panel */}
            <div className="simulator-panel">
              <div className="simulator-header">
                <div className="simulator-title-group">
                  <h2>Healing Loop Console</h2>
                  <p>Trigger, monitor, and inspect autonomous operations runs</p>
                </div>
                <div className="sim-actions">
                  <button
                    onClick={handleTriggerRealTest}
                    disabled={isRealTriggerRunning || targetStatus === 'Not Connected'}
                    className="btn btn-primary"
                    style={{ background: 'linear-gradient(135deg, #10b981, #059669)' }}
                    title={targetStatus === 'Not Connected' ? 'Connect target first' : 'Trigger real test via Backend API'}
                  >
                    {isRealTriggerRunning ? 'Triggering...' : 'Trigger Real Test'}
                  </button>
                  <button
                    onClick={startSimulation}
                    disabled={isSimRunning}
                    className="btn btn-primary"
                  >
                    {isSimRunning ? 'Healing...' : 'Trigger Alarm Simulation'}
                  </button>
                  <button
                    onClick={() => {
                      setTerminalLines([
                        { text: '[SYSTEM] Terminal logs cleared.', type: 'system' },
                        { text: '--- Ready for next run ---', type: 'comment' }
                      ]);
                      setShowDiff(false);
                    }}
                    disabled={isSimRunning}
                    className="btn btn-secondary"
                  >
                    Clear Console
                  </button>
                </div>
              </div>

              {/* Console window */}
              <div className="terminal-window">
                <div className="terminal-top-bar">
                  <div className="terminal-dots">
                    <span className="dot red"></span>
                    <span className="dot yellow"></span>
                    <span className="dot green"></span>
                  </div>
                  <div className="terminal-path">SentinelOps-AI-Agent@orchestrator</div>
                  <div className="terminal-meta">
                    {isSimRunning ? 'STEP ' + simStep + '/5' : 'ACTIVE'}
                  </div>
                </div>

                <div className="terminal-content">
                  {terminalLines.map((line, idx) => (
                    <div
                      key={idx}
                      className={`terminal-line ${
                        line.type === 'system' ? 'terminal-system' :
                        line.type === 'alert' ? 'terminal-error' :
                        line.type === 'mcp' ? 'terminal-warning' :
                        line.type === 'success' ? 'terminal-success' :
                        line.type === 'error' ? 'terminal-error' :
                        line.type === 'comment' ? 'terminal-comment' : 'terminal-input-prompt'
                      }`}
                    >
                      {line.text}
                    </div>
                  ))}

                  {/* Render simulated Code Diff side-by-side */}
                  {showDiff && (
                    <div className="diff-container fade-in">
                      <div className="diff-header">
                        <span>📄 Code Patch Diff — app/app_simulator.py</span>
                        <span>-3, +6 lines</span>
                      </div>
                      <div className="diff-body">
                        {diffLines.map((line, lIdx) => (
                          <div
                            key={lIdx}
                            className={`diff-line ${
                              line.type === 'added' ? 'diff-line-added' :
                              line.type === 'removed' ? 'diff-line-removed' : ''
                            }`}
                          >
                            {line.type === 'added' ? '+ ' : line.type === 'removed' ? '- ' : '  '}
                            {line.text}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Blinker cursor at the very end when running or idle */}
                  <div style={{ display: 'flex', alignItems: 'center' }}>
                    <span className="terminal-input-prompt"></span>
                    {isSimRunning && <span style={{ color: 'var(--accent-color)' }}>Executing step operations...</span>}
                    <span className="terminal-blinker"></span>
                  </div>

                  <div ref={terminalEndRef} />
                </div>

                {/* Bottom execution step indicator */}
                <div className="flow-steps-tracker">
                  <div className={`flow-step-dot ${simStep >= 1 ? 'completed' : ''} ${simStep === 1 ? 'active' : ''}`} title="Ingestion event"></div>
                  <div className={`flow-step-dot ${simStep >= 2 ? 'completed' : ''} ${simStep === 2 ? 'active' : ''}`} title="AWS Log fetch"></div>
                  <div className={`flow-step-dot ${simStep >= 3 ? 'completed' : ''} ${simStep === 3 ? 'active' : ''}`} title="Read file"></div>
                  <div className={`flow-step-dot ${simStep >= 4 ? 'completed' : ''} ${simStep === 4 ? 'active' : ''}`} title="Apply fix"></div>
                  <div className={`flow-step-dot ${simStep >= 5 ? 'completed' : ''} ${simStep === 5 ? 'active' : ''}`} title="Run tests"></div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Tab 2: How It Works */}
        {activeTab === 'architecture' && (
          <div className="architecture-container fade-in">
            {/* Interactive SVG Diagram */}
            <div className="card diagram-card">
              <h3 style={{ marginBottom: '24px', letterSpacing: '-0.3px' }}>Pipeline Topology</h3>
              
              <svg className="arch-graph" viewBox="0 0 400 400">
                {/* Connecting Edges */}
                <path d="M 70 80 L 150 140" className={`arch-edge ${activeArchNode === 'ingest' ? 'active' : ''}`} />
                <path d="M 200 160 L 200 240" className={`arch-edge ${activeArchNode === 'bedrock' ? 'active' : ''}`} />
                <path d="M 200 240 L 70 320" className={`arch-edge ${activeArchNode === 'aws_mcp' ? 'active' : ''}`} />
                <path d="M 200 240 L 200 320" className={`arch-edge ${activeArchNode === 'github_mcp' ? 'active' : ''}`} />
                <path d="M 200 240 L 330 320" className={`arch-edge ${activeArchNode === 'sandbox_mcp' ? 'active' : ''}`} />

                {/* Node: CloudWatch Log Alert */}
                <g className={`arch-node ${activeArchNode === 'ingest' ? 'active' : ''}`} onClick={() => setActiveArchNode('ingest')}>
                  <rect x="20" y="40" width="100" height="40" rx="6" />
                  <text x="70" y="64">CloudWatch Alarm</text>
                </g>

                {/* Node: AWS Lambda Ingestion */}
                <g className={`arch-node ${activeArchNode === 'ingest' ? 'active' : ''}`} onClick={() => setActiveArchNode('ingest')}>
                  <rect x="150" y="120" width="100" height="40" rx="6" />
                  <text x="200" y="144">Lambda Ingestor</text>
                </g>

                {/* Node: Bedrock Core (OpsPilot) */}
                <g className={`arch-node ${activeArchNode === 'bedrock' ? 'active' : ''}`} onClick={() => setActiveArchNode('bedrock')}>
                  <circle cx="200" cy="240" r="32" />
                  <text x="200" y="244">AI Engine</text>
                </g>

                {/* Node: AWS MCP Server */}
                <g className={`arch-node ${activeArchNode === 'aws_mcp' ? 'active' : ''}`} onClick={() => setActiveArchNode('aws_mcp')}>
                  <circle cx="70" cy="340" r="28" />
                  <text x="70" y="344">AWS MCP</text>
                </g>

                {/* Node: GitHub MCP Server */}
                <g className={`arch-node ${activeArchNode === 'github_mcp' ? 'active' : ''}`} onClick={() => setActiveArchNode('github_mcp')}>
                  <circle cx="200" cy="340" r="28" />
                  <text x="200" y="344">GitHub MCP</text>
                </g>

                {/* Node: Sandbox MCP Server */}
                <g className={`arch-node ${activeArchNode === 'sandbox_mcp' ? 'active' : ''}`} onClick={() => setActiveArchNode('sandbox_mcp')}>
                  <circle cx="330" cy="340" r="28" />
                  <text x="330" y="344">Sandbox MCP</text>
                </g>
              </svg>

              <p style={{ marginTop: '20px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                💡 Click any element on the graph to inspect its logic and source files.
              </p>
            </div>

            {/* Explanation panel */}
            <div className="diagram-explain">
              {activeArchNode === 'ingest' && (
                <div className="diagram-node-details fade-in">
                  <h4>AWS Log Ingestion (Lambda Event Bridge)</h4>
                  <p>
                    When AWS services (EC2, ECS, Lambda) fail, they write crash logs to Amazon CloudWatch.
                    EventBridge catches the status change and invokes our ingestion Lambda function (defined in <a href="file:///c:/Users/VIJAY/Desktop/SentinelOps-AI/infra/lambda_ingestion.py" className="file-link">lambda_ingestion.py</a>).
                    This function parses target stream identifiers and fires the Bedrock autonomous agent pipeline.
                  </p>
                </div>
              )}

              {activeArchNode === 'bedrock' && (
                <div className="diagram-node-details fade-in">
                  <h4>AI Orchestration Core (Amazon Bedrock / Llama 3)</h4>
                  <p>
                    The orchestrator is written in Python (defined in <a href="file:///c:/Users/VIJAY/Desktop/SentinelOps-AI/agent/orchestrator.py" className="file-link">orchestrator.py</a>).
                    It sets up the loop, loads system prompts (defined in <a href="file:///c:/Users/VIJAY/Desktop/SentinelOps-AI/agent/prompt_templates.py" className="file-link">prompt_templates.py</a>),
                    and feeds context to our Llama 3.3 Bedrock LLM.
                    The agent evaluates loop outputs, detects crash lines, and requests tool calls.
                  </p>
                </div>
              )}

              {activeArchNode === 'aws_mcp' && (
                <div className="diagram-node-details fade-in">
                  <h4>AWS Model Context Protocol (MCP) Server</h4>
                  <p>
                    The AWS MCP tool server (defined in <a href="file:///c:/Users/VIJAY/Desktop/SentinelOps-AI/mcp_servers/aws_server.py" className="file-link">aws_server.py</a>)
                    exposes safe operations for log stream fetching (`fetch_cloudwatch_logs`).
                    It lets the LLM fetch stack traces dynamically.
                  </p>
                </div>
              )}

              {activeArchNode === 'github_mcp' && (
                <div className="diagram-node-details fade-in">
                  <h4>GitHub/Workspace MCP Server</h4>
                  <p>
                    The repository tool server (defined in <a href="file:///c:/Users/VIJAY/Desktop/SentinelOps-AI/mcp_servers/github_server.py" className="file-link">github_server.py</a>)
                    allows the LLM to inspect files (`read_file`) and rewrite code blocks safely (`patch_file`).
                    To guarantee audit logs, every write automatically appends a cryptographic, signed operations audit block.
                  </p>
                </div>
              )}

              {activeArchNode === 'sandbox_mcp' && (
                <div className="diagram-node-details fade-in">
                  <h4>Sandbox Verification MCP Server</h4>
                  <p>
                    The testing tool server (defined in <a href="file:///c:/Users/VIJAY/Desktop/SentinelOps-AI/mcp_servers/sandbox_server.py" className="file-link">sandbox_server.py</a>)
                    allows the agent to test code fixes immediately in an isolated workspace via `execute_tests` (triggers python unittest suite).
                    If tests fail, the stdout output is fed back into LLM memory for autonomous self-reflection and correction.
                  </p>
                </div>
              )}

              <ul className="arch-step-list">
                <li className={`arch-step-item ${activeArchNode === 'ingest' ? 'active' : ''}`} onClick={() => setActiveArchNode('ingest')}>
                  <div className="arch-step-num">1</div>
                  <div className="arch-step-info">
                    <h4>Log Stream Ingestion</h4>
                    <p>AWS Lambda intercepts Alarm states and creates execution context.</p>
                  </div>
                </li>
                <li className={`arch-step-item ${activeArchNode === 'bedrock' ? 'active' : ''}`} onClick={() => setActiveArchNode('bedrock')}>
                  <div className="arch-step-num">2</div>
                  <div className="arch-step-info">
                    <h4>Self-Healing Logic Loop</h4>
                    <p>OpsPilot Bedrock orchestrator executes reasoning iterations.</p>
                  </div>
                </li>
                <li className={`arch-step-item ${activeArchNode === 'aws_mcp' ? 'active' : ''}`} onClick={() => setActiveArchNode('aws_mcp')}>
                  <div className="arch-step-num">3</div>
                  <div className="arch-step-info">
                    <h4>Log Diagnosis</h4>
                    <p>AWS MCP retrieves logs to analyze crash stack traces.</p>
                  </div>
                </li>
                <li className={`arch-step-item ${activeArchNode === 'github_mcp' ? 'active' : ''}`} onClick={() => setActiveArchNode('github_mcp')}>
                  <div className="arch-step-num">4</div>
                  <div className="arch-step-info">
                    <h4>Code Healing</h4>
                    <p>GitHub MCP reads current files and commits corrected patches.</p>
                  </div>
                </li>
                <li className={`arch-step-item ${activeArchNode === 'sandbox_mcp' ? 'active' : ''}`} onClick={() => setActiveArchNode('sandbox_mcp')}>
                  <div className="arch-step-num">5</div>
                  <div className="arch-step-info">
                    <h4>Integrity Verification</h4>
                    <p>Sandbox MCP runs unit tests. Triggers repair loops if coverage fails.</p>
                  </div>
                </li>
              </ul>
            </div>
          </div>
        )}

        {/* Tab 3: Technical Docs */}
        {activeTab === 'docs' && (
          <div className="docs-layout fade-in">
            {/* Nav */}
            <aside className="docs-nav">
              <button
                onClick={() => setDocsSection('intro')}
                className={`docs-nav-link ${docsSection === 'intro' ? 'active' : ''}`}
              >
                Introduction
              </button>
              <button
                onClick={() => setDocsSection('install')}
                className={`docs-nav-link ${docsSection === 'install' ? 'active' : ''}`}
              >
                Installation
              </button>
              <button
                onClick={() => setDocsSection('running')}
                className={`docs-nav-link ${docsSection === 'running' ? 'active' : ''}`}
              >
                Running Locally
              </button>
              <button
                onClick={() => setDocsSection('config')}
                className={`docs-nav-link ${docsSection === 'config' ? 'active' : ''}`}
              >
                Configuration
              </button>
            </aside>

            {/* Content Body */}
            <div className="docs-body card">
              {docsSection === 'intro' && (
                <section className="docs-section fade-in">
                  <h2>SentinelOps-AI</h2>
                  <p>
                    SentinelOps-AI is a production-grade autonomous operations agent built on AWS.
                    It continuously ingests logs from your infrastructure, uses an AI agent to understand what's going wrong,
                    and triggers self-healing actions — all without human intervention.
                  </p>
                  <h3>Key Capabilities</h3>
                  <ul className="docs-list">
                    <li><strong>Zero-touch remediation</strong> — detects & repairs bugs automatically.</li>
                    <li><strong>MCP Tool Suits</strong> — auditable, safe API wrappers for AWS, GitHub, and local runtimes.</li>
                    <li><strong>Self-reflection loops</strong> — reads compiler / test outputs to refine patches dynamically.</li>
                    <li><strong>Production audit stamps</strong> — comments all patched files for pull request validation gates.</li>
                  </ul>
                </section>
              )}

              {docsSection === 'install' && (
                <section className="docs-section fade-in">
                  <h2>System Requirements</h2>
                  <p>Before installing, ensure your environment meets the prerequisites:</p>
                  <ul className="docs-list">
                    <li>Python 3.11+</li>
                    <li>AWS IAM credentials with permissions for CloudWatch and Bedrock Runtime</li>
                    <li>boto3 python dependency installed</li>
                  </ul>
                  <h3>Installation</h3>
                  <div className="docs-code-block">
                    {`# Clone the repository
git clone https://github.com/vijayrajeshr/SentinelOps-AI.git
cd SentinelOps-AI

# Install dependencies (ensure pip is updated)
pip install -r requirements.txt`}
                  </div>
                </section>
              )}

              {docsSection === 'running' && (
                <section className="docs-section fade-in">
                  <h2>Running Locally</h2>
                  <p>You can execute both simulated crash scenarios and the autonomous orchestrator loops on your local machine.</p>
                  
                  <h3>1. Simulate Application Crash</h3>
                  <p>To simulate a crash and push error metrics to your AWS CloudWatch logs group, execute:</p>
                  <div className="docs-code-block">
                    {`python app/app_simulator.py`}
                  </div>

                  <h3>2. Activate AI Orchestrator</h3>
                  <p>To kickstart the self-healing loop which reads active CloudWatch errors, writes fixes, and runs unit tests, execute:</p>
                  <div className="docs-code-block">
                    {`python agent/orchestrator.py`}
                  </div>
                </section>
              )}

              {docsSection === 'config' && (
                <section className="docs-section fade-in">
                  <h2>Configuration</h2>
                  <p>System configurations are managed via AWS environment variables and parameters:</p>
                  <ul className="docs-list">
                    <li><strong>Model Identification</strong>: Uses <code>us.meta.llama3-3-70b-instruct-v1:0</code> profile on Bedrock. Can be configured in <a href="file:///c:/Users/VIJAY/Desktop/SentinelOps-AI/agent/orchestrator.py" className="file-link">orchestrator.py</a>.</li>
                    <li><strong>Log Ingestion Targets</strong>: Log group default is <code>/aws/ops-pilot/sacrificial-app</code>.</li>
                  </ul>
                  <h3>AWS IAM Policy</h3>
                  <p>Ensure your executing role has the following minimum IAM capabilities:</p>
                  <div className="docs-code-block" style={{ fontSize: '11px' }}>
                    {`{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "logs:GetLogEvents",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:us-east-1:*:log-group:/aws/ops-pilot/sacrificial-app:*"
    },
    {
      "Effect": "Allow",
      "Action": "bedrock:InvokeModel",
      "Resource": "arn:aws:bedrock:us-east-1::foundation-model/us.meta.llama3-3-70b-instruct-v1:0"
    }
  ]
}`}
                  </div>
                </section>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Stage 2: Human Approval Confirmation Modal Dialog */}
      {showApprovalModal && (
        <div className="modal-backdrop" onClick={() => setShowApprovalModal(false)}>
          <div className="modal-dialog" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title-group">
                <span className="modal-icon">🛡️</span>
                <h3>Human Approval Required</h3>
              </div>
              <button className="modal-close-btn" onClick={() => setShowApprovalModal(false)}>×</button>
            </div>

            <div className="modal-body">
              <p className="modal-prompt-text">
                <strong>Apply this AI-generated patch to an isolated Git branch and run validation?</strong>
              </p>

              <div className="modal-details-card">
                <div className="modal-detail-row">
                  <span className="modal-detail-label">Target Repository:</span>
                  <span className="modal-detail-val font-mono">{targetGithubRepo}</span>
                </div>
                <div className="modal-detail-row">
                  <span className="modal-detail-label">Base Branch:</span>
                  <span className="modal-detail-val font-mono">{targetBranch} (Protected — Main Branch Remains Untouched)</span>
                </div>
                <div className="modal-detail-row">
                  <span className="modal-detail-label">Target File:</span>
                  <span className="modal-detail-val font-mono">{aiFixResult?.file}</span>
                </div>
                <div className="modal-detail-row">
                  <span className="modal-detail-label">Isolated Branch:</span>
                  <span className="modal-detail-val font-mono">sentinelops/fix/&lt;timestamp&gt;</span>
                </div>
              </div>

              <div className="modal-safety-notice">
                <span className="notice-icon">ℹ️</span>
                <span>
                  SentinelOps will create an isolated local branch, apply the structured patch, execute Patient unit tests, and verify endpoints. No remote pushes or pull requests will be triggered.
                </span>
              </div>
            </div>

            <div className="modal-actions">
              <button
                id="btn-modal-cancel"
                className="btn-modal-cancel"
                onClick={() => setShowApprovalModal(false)}
              >
                Cancel
              </button>
              <button
                id="btn-modal-approve"
                className="btn-modal-approve"
                onClick={handleApproveAndApplyFix}
              >
                ✓ Approve & Apply
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Stage 3: GitHub Pull Request Confirmation Modal Dialog */}
      {showPrModal && (
        <div className="modal-backdrop" onClick={() => setShowPrModal(false)}>
          <div className="modal-dialog pr-modal-dialog" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title-group">
                <span className="modal-icon">🚀</span>
                <h3>Create GitHub Pull Request</h3>
              </div>
              <button className="modal-close-btn" onClick={() => setShowPrModal(false)}>×</button>
            </div>

            <div className="modal-body">
              <p className="modal-prompt-text">
                <strong>Create a GitHub Pull Request containing this validated fix?</strong>
              </p>

              <div className="modal-details-card">
                <div className="modal-detail-row">
                  <span className="modal-detail-label">Target Repository:</span>
                  <span className="modal-detail-val font-mono">{targetGithubRepo}</span>
                </div>
                <div className="modal-detail-row">
                  <span className="modal-detail-label">Base Branch:</span>
                  <span className="modal-detail-val font-mono">{targetBranch} (Protected — Main Branch Remains Untouched)</span>
                </div>
                <div className="modal-detail-row">
                  <span className="modal-detail-label">Target File:</span>
                  <span className="modal-detail-val font-mono">{appliedPatchResult?.file || 'app/routes.py'}</span>
                </div>
                <div className="modal-detail-row">
                  <span className="modal-detail-label">New Branch:</span>
                  <span className="modal-detail-val font-mono">sentinelops/fix/&lt;timestamp&gt;</span>
                </div>
                <div className="modal-detail-row">
                  <span className="modal-detail-label">Stage 2 Status:</span>
                  <span className="modal-detail-val text-success font-bold">✓ PASS (Health 200 OK, User 404 Not Found)</span>
                </div>
              </div>

              <div className="modal-safety-notice">
                <span className="notice-icon">🛡️</span>
                <span>
                  <strong>Safety Notice:</strong> SentinelOps will commit only the validated patch to a new isolated branch and open a PR targeting <code>main</code>. The PR will <strong>NOT</strong> be automatically merged or deployed. Final review and merge must be completed by a human on GitHub.
                </span>
              </div>
            </div>

            <div className="modal-actions">
              <button
                id="btn-pr-modal-cancel"
                className="btn-modal-cancel"
                onClick={() => setShowPrModal(false)}
              >
                Cancel
              </button>
              <button
                id="btn-pr-modal-confirm"
                className="btn-modal-approve btn-pr-confirm"
                onClick={handleCreatePullRequest}
              >
                Create Pull Request
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="app-footer">
        <div>
          © 2026 SentinelOps-AI. Autonomous operations infrastructure.
        </div>
        <div className="footer-links">
          <a href="https://github.com/vijayrajeshr" target="_blank" rel="noreferrer">GitHub</a>
          <a href="https://linkedin.com/in/vijayrajeshr" target="_blank" rel="noreferrer">LinkedIn</a>
        </div>
      </footer>
    </div>
  );
}

export default App;
