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

  const terminalEndRef = useRef<HTMLDivElement>(null);

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
