# Diamond Hacks 2026 — Project Brief

## Mission (what we are doing this for)

Ship a **judge-clear** hackathon project: a **local Llama**-powered agent whose **default superpowers** are **Browser Use** (real web automation with a **live embedded session**) and **ElevenLabs** (spoken replies), demoed **across phone and laptop** for the **Qualcomm** track. Secondary angles: **Best Interactive AI** (interaction is the product) and optionally **MLH .tech** (deployed on a promo domain).

## Project overview

We are building an **AI agent assistant** that runs **locally** where possible, routes work through an **MCP (Model Context Protocol) tool layer**, and delivers a **responsive web experience** with a **live view of automated browsing** plus **spoken responses**. The product targets hackathon judging tracks that reward **on-device / AI PC intelligence** (Qualcomm), **real browser automation via Browser Use**, and **natural voice output via ElevenLabs**.

### Office snapshot (what we aligned on)

Think of this block as the **whiteboard after a planning session**: the decisions that matter before anyone ships code.

- **Stack:** Local **Llama 3.1B** + **MCP** tools; **plain Python / thin HTTP** over heavy agent SDKs (Fetch AI out).
- **Tools:** **Browser Use** for web; **ElevenLabs** for voice; routing is **prompt + inferred intent**.
- **Browser Use:** Headless + sandbox; **live embed** via cloud SDK; **credentials** OK for gated sites; session stays **private to us**.
- **Product shape:** **Responsive web** (not a native app); **three-column dashboard** supports the main **agent/robot** experience.
- **Tracks we are aiming at:** **Qualcomm** first, then **Browser Use**, then **ElevenLabs**; **Best Interactive AI** as wildcard; **.tech** optional.

### Sponsor goals at a glance

| Sponsor / track | What “winning” looks like for us |
|-----------------|----------------------------------|
| **Qualcomm** | Same app, **phone + laptop**, local model + AI PC story, polished demo |
| **Browser Use** | **Core flows** require Browser Use; **live view** in UI; clarify **“fully software based”** with organisers |
| **ElevenLabs** | Agent-driven **TTS**; move toward **real-time** audio in later phases |
| **Best Interactive AI** | Live browser + voice + settings = **interactive** by construction |
| **MLH .tech** | Deploy on **.tech** with promo; confirm redemption |

### Why we are building it (sponsor alignment)

- **Qualcomm (primary):** We demonstrate **multi-device** value (phone + laptop) and an **AI PC** story: a **local Llama 3.1B** reasoning core plus capable hardware running the agent and browser automation. The same responsive web app is the demo surface on both form factors.

- **Browser Use (primary):** Core agent capability **depends on Browser Use** for the web—not a decorative add-on. We use **headless** automation, **sandboxed** execution, **live session view** embedded via the **cloud SDK** ("watch the agent browse in real time, embedded in your app"), with the session kept on **our** project side. We support **authenticated browsing** by passing **username and password** into Browser Use when flows require login.

- **ElevenLabs / 11 Labs (primary):** We expose **text-to-speech** through MCP when the task is conversational or should be heard. We aim for **real-time or near–real-time** audio from agent output, with room to deepen integration in Phase 2.

- **Best Interactive AI (wildcard):** The agent is **interactive by design**: live browser pane, settings, reminders, and voice output—aligned with interactive / entertainment-oriented judging criteria.

- **MLH .tech domain (optional):** We may deploy on a **.tech** domain using the hackathon promo to qualify for that track; redemption steps still need confirmation.

We are **not** prioritizing **12 Labs** (video API) or **Solana** for the current scope. **Fetch AI** was evaluated as an agent framework but **rejected** in favor of a **custom Python / thin endpoints** stack for control and clearer **Qualcomm + Browser Use + ElevenLabs** narrative.

---

## Agent architecture

- **Base model:** Llama **3.1B** running **locally** (~3.1B parameters, per team discussion).
- **MCP layer:** On top of the model; handles **tool routing**.
- **Routing:** System prompt logic plus model intent inference:
  - Web interaction goes to **Browser Use** MCP tool.
  - Conversation / audio response goes to **ElevenLabs TTS** MCP tool.
- **Browser Use:** Headless, sandboxed; live view via cloud SDK; optional credential handoff for gated sites.
- **Open question:** Standalone **API layer** for agent endpoints vs. monolith for hackathon speed.

---

## Hackathon tracks and prizes (priority order)

**Primary**

1. **Qualcomm** — Multi-device, **AI PC** focus; best overall prize positioning.
2. **Browser Use** — Core functionality must rely on Browser Use; prizes include **two iPhone 17 Pros**, **AirPods**, and a **week-long hacker house + Transco** trip.
3. **ElevenLabs** — **TTS** and **real-time audio** from the agent.

**Secondary / under consideration**

- **Best Interactive AI** — Natural fit; optional extra submission angle.
- **Fetch AI** — Deprioritised (less control, lower prize fit vs. custom stack).
- **MLH .tech** — Needs **.tech** domain plus promo redemption (TBD).

**Skipped for now**

- **12 Labs**, **Solana**.

**Uncertainties**

- **Browser Use:** Clarify **"fully software based"** with organisers.
- **.tech:** Confirm exact **domain redemption** process (SF / hackathon code).

---

## UI and product plan

- **Platform:** **Responsive website** (not a native app)—desktop and mobile, supporting **Qualcomm** cross-device demos without app store scope creep.
- **Hero experience:** The **robot / agent interface** is primary; the **dashboard** is secondary.
- **Three-column dashboard:**
  1. **Live browser** — Real-time Browser Use session (cloud SDK embed).
  2. **Agent settings** — Configuration (capabilities, prompts, schedules).
  3. **Toggles + reminders** — Simple fields (name, date/time); e.g. medication-style lines **fed into the system prompt** ("every 3 hours, take this med").
- **Settings:** Toggle capabilities (e.g. fall detection); keep reminder logic simple for MVP/Phase 1.

---

## Phased roadmap

**MVP:** Local Llama 3.1B plus MCP routing; Browser Use and ElevenLabs TTS callable; basic browser-vs-TTS routing.

**Phase 1:** Responsive dashboard; embedded live browser; settings toggles and reminders; authenticated browsing via Browser Use.

**Phase 2:** Multi-agent or proxy view; deeper ElevenLabs (e.g. real-time voice); Qualcomm demo polish; 12 Labs only if time allows (low priority).

---

## Next steps

**Everyone:** Whiteboard MVP, Phase 1, and Phase 2 boundaries; confirm "fully software based" with Browser Use organisers; finalise track list (Qualcomm, Browser Use, ElevenLabs; wildcard Best Interactive AI).

**Nikhil:** Check Matthew's Browser Use experience; **Tailscale** for remote laptop access; **.tech** domain promo and redemption; spike **live session embed** in dashboard; verify **GPU/RAM** (~120GB RAM noted) for local model plus headless Browser Use.

**xd:** TBD.

---

## One-line pitch (draft)

Local Llama plus MCP routes **Browser Use** for live, embeddable web automation and **ElevenLabs** for voice—the same responsive app on **phone and laptop** for **Qualcomm**, with **Browser Use** and **ElevenLabs** as first-class prize stories.
