# Senior Care Robot Assistant — Hackathon Build Notes

---

## What is this?

A **physical/software robot assistant** built for **senior citizens**. The robot acts as a personal **companion and caretaker** — it listens, speaks, and acts on behalf of the user. It handles daily needs through **natural voice conversation**, **autonomously completes tasks on the web** (shopping, bookings, lookups) using a **computer-use agent**, and tracks everything in a **companion dashboard** for caregivers or family members to monitor.

The **robot is the primary interface**. Everything else (dashboard, browser agent, reminders) exists to **support the robot’s ability to care for the user**.

---

## Instructions — run frontend + backend

Run **two terminals**: API first, then the Vite dev server.

### Prerequisites

- **Backend:** Python **3.11+** and [**uv**](https://github.com/astral-sh/uv) (recommended) or another way to install deps from `backend/pyproject.toml`.
- **Frontend:** **Node.js** (LTS) with **npm**, or **Bun** if you use the repo’s `bun.lock`.

### Backend (FastAPI)

From the **repository root**:

```bash
cd backend
uv sync
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

- **Health check:** [http://127.0.0.1:8000/health](http://127.0.0.1:8000/health) should return `{"status":"ok"}`.
- **Config:** Optional `backend/.env` (or a `.env` at the **repo root** — see `backend/app/config.py`). Defaults allow **mock Browser Use** (`BROWSER_USE_MOCK_MODE=true`) without a cloud key for local UI work.
- **CORS:** By default the API allows the Vite dev origin `http://localhost:5173` and `http://127.0.0.1:5173`.

### Frontend (Svelte + Vite)

In a **second terminal**, from the repo root:

```bash
cd frontend
npm install
```

Point the UI at the API (Vite does **not** proxy `/api` in this repo). Create `frontend/.env` or `frontend/.env.local`:

```bash
echo 'VITE_API_BASE_URL=http://127.0.0.1:8000' > .env.local
```

Start the dev server:

```bash
npm run dev
```

- **App:** [http://localhost:5173](http://localhost:5173) (Vite default port).
- If you use **Bun:** `bun install` then `bun run dev` from `frontend/`.

### Quick checklist

| Step | Command / URL |
|------|----------------|
| 1 | `cd backend && uv sync && uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000` |
| 2 | Set `VITE_API_BASE_URL=http://127.0.0.1:8000` in `frontend/.env.local` |
| 3 | `cd frontend && npm install && npm run dev` |
| 4 | Open the dashboard at `http://localhost:5173` |

---

## Core concept

| Piece | Role |
|-------|------|
| **Robot** | Voice-interactive agent (physical or screen-based) that seniors talk to naturally |
| **Brain** | Local Llama 3.1B + MCP routing layer that decides how to respond |
| **Hands** | Browser Use agent that autonomously operates a browser to complete real-world tasks (e.g. order groceries, book a doctor’s appointment) |
| **Voice** | 11 Labs TTS for natural, real-time spoken responses |
| **Dashboard** | Caregiver/family-facing web UI to monitor activity, configure reminders, toggle features, and view live browser sessions |

---

## System architecture

### Core stack

- **Local model:** Llama 3.1B (~3.1B parameters)
- **MCP layer:** Handles all tool routing on top of the base model
- **Agent framework:** Plain Python with custom endpoints — no pre-built agent SDKs

### Routing logic

```
incoming_input
  → system_prompt evaluates intent
      ├── requires web interaction → call Browser Use MCP tool
      │     └── Browser Use runs headlessly in sandboxed environment
      └── requires conversation/response → call TTS tool (11 Labs)
```

### Browser Use integration

- Runs **headlessly** inside a **sandbox**
- **Authenticated browsing:** pass username + password directly to Browser Use for login-gated sites
- **Live session view** via cloud SDK:
  - Feature: “Watch the agent browse in real time, embedded in your app”
  - Session stays **server-side**; not exposed externally
  - **Action:** confirm embeddability in dashboard before building

### Agent framework decision

| Choice | Rationale |
|--------|-----------|
| **Rejected:** Pre-built SDKs (OpenAI Agent SDK, LangGraph, CrewAI) | Want ownership of routing and demos |
| **Chosen:** Plain Python + custom MCP endpoints | Flexibility + **Qualcomm** track compatibility |

**Fetch AI:** We **do care** about this sponsor / hackathon track — read their requirements, decide if we submit against it, and whether any slice of the product should use or reference their stack. That is separate from defaulting the core agent to **custom Python + MCP** for control and judge narrative.

**Open question:** Standalone API layer for agent endpoints vs. monolith for hackathon speed (team TBD).

---

## UI specification

### Platform

- **Responsive website** (not native app)
- **Adaptive layout:** desktop + mobile via standard responsive web design
- Native app **deprioritised** for hackathon scope

### Dashboard layout — three columns

| Column | Content |
|--------|---------|
| **1** | **Live browser view** — real-time Browser Use session (cloud SDK embed) |
| **2** | **Agent settings** + configuration panel |
| **3** | **Feature toggles** + reminders |

### Settings panel features

- **Toggle capabilities** on/off (e.g. `fall_detection`, `browser_mode`)
- **Add reminders:**
  - Fields: **name**, **date/time**
  - Example: “every 3 hours, take this med” → **injected into system prompt**
- **Display** active agent runs / agent history (**agent proxy view**)

### Primary UI

- **Main interface** = robot / agent **conversational UI**
- **Dashboard** = secondary / supporting view

---

## Hackathon tracks

### Priority 1 — Qualcomm

- Focus: **multi-device AI PC** (phone + laptop)
- Requirement: demonstrate **cross-device** behaviour
- Responsive website satisfies this **without** a native app
- **Best overall prize** — highest priority

### Priority 2 — Browser Use

- Requirement: **core functionality** must rely on Browser Use
- Prizes: **2× iPhone 17 Pro**, **AirPods**, week-long hacker house trip + Transco
- **Open question:** confirm definition of **“fully software based”** with organisers **tomorrow**

### Priority 3 — 11 Labs

- **Integration:** real-time **TTS** output from agent
- Called via **MCP tool** when routing logic selects the conversation path

### Priority 4 — Fetch AI

- **We care about this track:** align submission and demo story with Fetch AI’s requirements where it doesn’t block Browser Use / Qualcomm / 11 Labs priorities.
- **Action:** confirm official criteria and whether a minimal Fetch AI integration or a parallel “agent marketplace” narrative is worth the time budget.

### Wildcard — Best Interactive AI

- Project **qualifies:** interactive by nature (voice + browser agent)
- Criteria: “interactive entertainment, play with or experience of fun”
- **Evaluate if time permits**

### Skipped tracks

- **12 Labs** — multimodal video API; not relevant
- **Solana** — blockchain; not relevant

---

## Phased roadmap

### MVP

- [ ] MCP routing layer implemented
- [ ] Browser Use tool callable from agent
- [ ] TTS tool callable from agent (11 Labs)
- [ ] System prompt routing logic (browser vs. TTS path)

### Phase 1

- [ ] Responsive web dashboard live
- [ ] Live browser view embedded via cloud SDK
- [ ] Settings panel: toggles + reminder creation
- [ ] Authenticated browsing (credentials passed to Browser Use)

### Phase 2

- [ ] Multi-agent orchestration or agent proxy dashboard view
- [ ] 11 Labs deeper real-time voice integration
- [ ] Cross-device polish for Qualcomm demo
- [ ] 12 Labs video intelligence (low priority, time permitting)

---

## Next steps (team)

- Whiteboard **MVP vs Phase 1** boundaries; lock embed spike for live session.
- Confirm **“fully software based”** with Browser Use organisers.
- Finalise track list: Qualcomm, Browser Use, ElevenLabs, **Fetch AI**; wildcard Best Interactive AI.
- **Nikhil:** Browser Use experience / live embed spike; remote laptop access if needed; **GPU/RAM** check for local model + headless Browser Use.
- **xd:** TBD.
