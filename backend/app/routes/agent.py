from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session

from ..config import get_settings
from ..db import get_session
from ..schemas import AgentTurnRequest
from ..services.browser_state import begin_browser_task
from ..services.browser_use import browser_use_service
from ..services.transcript_bus import create_transcript_entry, transcript_bus


router = APIRouter(prefix="/api/agent", tags=["agent"])


BROWSER_HINTS = (
    "browser",
    "search",
    "look up",
    "lookup",
    "find",
    "open",
    "visit",
    "check the website",
    "order",
    "book",
    "schedule",
    "buy",
)


def _role_for_source(source: str) -> str:
    if source in {"dashboard", "guardian"}:
        return "guardian"
    return "resident"


def _needs_browser(message: str, force_browser: bool | None) -> bool:
    if force_browser is not None:
        return force_browser

    normalized = message.lower()
    return any(hint in normalized for hint in BROWSER_HINTS)


@router.post("/turn")
async def create_agent_turn(
    payload: AgentTurnRequest,
    session: Session = Depends(get_session),
) -> dict[str, object]:
    if not payload.message.strip():
        raise HTTPException(status_code=400, detail="Message is required.")

    user_role = _role_for_source(payload.source)
    resident_message = create_transcript_entry(
        session,
        kind="message",
        role=user_role,
        text=payload.message.strip(),
    )
    await transcript_bus.publish("transcript", resident_message)

    if _needs_browser(payload.message, payload.force_browser):
        browser_session = begin_browser_task(
            session,
            task=payload.message.strip(),
            profile_id=payload.profile_id or get_settings().browser_use_profile_id,
            idle_window_seconds=get_settings().browser_use_idle_stop_seconds,
        )

        queued_event = create_transcript_entry(
            session,
            kind="tool",
            role="system",
            text=f"Queued browser task: {payload.message.strip()}",
            tool_name="browser-use",
            tool_status="started",
            metadata={"browserSessionId": browser_session.id},
        )
        await transcript_bus.publish("tool", queued_event)

        asyncio.create_task(
            browser_use_service.run_browser_task(
                browser_session_id=browser_session.id,
                task=payload.message.strip(),
                profile_id=payload.profile_id or browser_session.profile_id,
                remote_session_id=browser_session.browser_use_session_id,
            )
        )
        return {
            "route": "browser_task",
            "browserSessionId": browser_session.id,
            "previewUrl": browser_session.preview_url,
            "status": "queued",
        }

    reply = "I logged that request. The guardian console is ready when you want me to use the browser."
    robot_message = create_transcript_entry(
        session,
        kind="message",
        role="robot",
        text=reply,
    )
    await transcript_bus.publish("transcript", robot_message)
    return {"route": "conversation", "reply": reply}
