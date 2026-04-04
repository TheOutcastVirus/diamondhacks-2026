# Senior Care Robot Assistant — Hackathon Build Notes

---

## What is this?

A **physical/software robot assistant** built for **senior citizens**. The robot acts as a personal **companion and caretaker** — it listens, speaks, and acts on behalf of the user. It handles daily needs through **natural voice conversation**, **autonomously completes tasks on the web** (shopping, bookings, lookups) using a **computer-use agent**, and tracks everything in a **companion dashboard** for caregivers or family members to monitor.

The **robot is the primary interface**. Everything else (dashboard, browser agent, reminders) exists to **support the robot’s ability to care for the user**.

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
| **Rejected:** Fetch AI | Too pre-built; insufficient control |
| **Rejected:** Pre-built SDKs (OpenAI Agent SDK, LangGraph, CrewAI) | Same — want ownership of routing and demos |
| **Chosen:** Plain Python + custom MCP endpoints | Flexibility + **Qualcomm** track compatibility |

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
- Finalise track list: Qualcomm, Browser Use, ElevenLabs; wildcard Best Interactive AI.
- **Nikhil:** Browser Use experience / live embed spike; remote laptop access if needed; **GPU/RAM** check for local model + headless Browser Use.
- **xd:** TBD.
