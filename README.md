# 🛡️ SentinelOps-AI

**https://sentinel-ops-ai-iota.vercel.app/**

> **Autonomous AI-powered log analysis and self-healing pipeline for AWS infrastructure.**  
> Detects anomalies. Diagnoses root causes. Remediates — without waking anyone up.

---

<img width="1407" height="1079" alt="Screenshot 2026-07-02 142659" src="https://github.com/user-attachments/assets/ac63c491-5f0d-49a4-b3ee-6d19fcae1d18" />

---

## 🚀 What It Does

SentinelOps-AI is a production-grade autonomous operations agent built on AWS. It continuously ingests logs from your infrastructure, uses an AI agent to understand what's going wrong, and triggers self-healing actions — all without human intervention.

No more 3 AM pages for issues that fix themselves. No more sifting through thousands of log lines. SentinelOps-AI watches, thinks, and acts.

---

## ⚙️ How It Works

```
AWS Infrastructure Logs
        │
        ▼
┌───────────────────┐
│   Log Ingestion   │  ← CloudWatch, S3, Kinesis
│     (app/)        │
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│   AI Agent Core   │  ← Pattern detection, anomaly analysis,
│    (agent/)       │    root cause reasoning via LLM
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│   MCP Servers     │  ← Tool layer: restarts, scaling,
│  (mcp_servers/)   │    alerts, rollbacks, SNS/SQS triggers
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│  Self-Healing     │  ← Automated remediation executed
│    Actions        │    against live AWS environment
└───────────────────┘
```

**The loop:**
1. Logs stream in from AWS (CloudWatch, S3, Kinesis Data Streams)
2. The AI agent parses and analyzes patterns — errors, latency spikes, service crashes
3. It reasons about root cause using an LLM with context from your infra
4. MCP servers expose safe, scoped tools the agent can invoke (restart service, scale ASG, trigger SNS alert, open incident)
5. Remediation fires automatically — the agent closes the loop

---

## 🏗️ Project Structure

```
SentinelOps-AI/
├── agent/          # Core AI agent — reasoning, decision engine, tool orchestration
├── app/            # Log ingestion layer + orchestration entrypoint
├── infra/          # AWS infrastructure as code (IaC)
├── mcp_servers/    # MCP tool servers — expose AWS actions to the agent
├── tests/          # Test suite
├── requirements.txt
└── README.md
```

---

## 🧠 Tech Stack

| Layer | Technology |
|---|---|
| Cloud | AWS (CloudWatch, S3, Lambda, SNS, SQS, EC2/ECS) |
| AI Agent | Python + LLM (Claude / OpenAI) |
| Tool Protocol | Model Context Protocol (MCP) |
| Infrastructure | AWS CDK / Terraform |
| Language | Python 3.11+ |

---

## 🔧 Key Features

- **Zero-touch remediation** — agent detects and fixes without human escalation
- **MCP-based tool layer** — clean, auditable interface between the AI and your AWS environment
- **Root cause reasoning** — not just pattern matching; the agent explains *why* it's taking action
- **Pluggable actions** — restart, scale, rollback, alert, or open an incident ticket
- **Fully async pipeline** — non-blocking log ingestion handles high-throughput environments
- **Audit trail** — every agent decision and action is logged for post-incident review

---

## 📦 Getting Started

### Prerequisites

- Python 3.11+
- AWS account with appropriate IAM permissions
- API key for your chosen LLM provider

### Installation

```bash
git clone https://github.com/vijayrajeshr/SentinelOps-AI.git
cd SentinelOps-AI
pip install -r requirements.txt
```

### Configure AWS

```bash
aws configure
# Set your region, access key, and secret key
```

### Run the Agent

```bash
python app/main.py
```

The agent will begin ingesting logs and monitoring your infrastructure immediately.

---

## 🗺️ Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│                      AWS Environment                     │
│                                                          │
│  EC2 / ECS / Lambda ──► CloudWatch Logs                 │
│                               │                          │
│                         Kinesis / S3                     │
└───────────────────────────────┼─────────────────────────┘
                                │
                    ┌───────────▼──────────┐
                    │   SentinelOps-AI     │
                    │                      │
                    │  ┌────────────────┐  │
                    │  │  Log Ingestion │  │
                    │  └───────┬────────┘  │
                    │          │           │
                    │  ┌───────▼────────┐  │
                    │  │   AI Agent     │  │
                    │  │  (LLM Core)    │  │
                    │  └───────┬────────┘  │
                    │          │           │
                    │  ┌───────▼────────┐  │
                    │  │  MCP Servers   │  │
                    │  └───────┬────────┘  │
                    └──────────┼───────────┘
                               │
              ┌────────────────┼─────────────────┐
              │                │                 │
         Restart           Scale ASG        SNS Alert /
         Service           Policies         PagerDuty
```

---

## 🧪 Running Tests

```bash
pytest tests/
```

---

## 🛣️ Roadmap

- [ ] Slack / Teams integration for agent action summaries
- [ ] Multi-region support
- [ ] Grafana dashboard for agent activity
- [ ] Fine-tuned model for domain-specific log patterns
- [ ] Support for GCP and Azure log sources

---

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.

---

## 👤 Author

**Vijay Rajesh R**  
[GitHub](https://github.com/vijayrajeshr) · [LinkedIn](https://linkedin.com/in/vijayrajeshr)

---

> *"Don't page the engineer. Let the system fix itself."*
