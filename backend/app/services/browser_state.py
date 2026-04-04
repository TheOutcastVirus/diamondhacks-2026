from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import desc
from sqlmodel import Session, delete, select

from ..models import BrowserActionRecord, BrowserSessionRecord


IDLE_BROWSER_CONTEXT = {
    "url": "No page loaded",
    "title": "Awaiting browser state",
    "summary": "Once the backend exposes browser context, this page will mirror the active page, task, and recent browser actions.",
    "status": "idle",
    "activeTask": "Waiting for browser automation",
    "tabLabel": "No active tab",
    "domSnippet": "",
    "previewUrl": None,
    "screenshotUrl": None,
    "recentActions": [],
}


def _isoformat(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _serialize_action(record: BrowserActionRecord) -> dict[str, object]:
    payload: dict[str, object] = {
        "id": record.id,
        "kind": record.kind,
        "detail": record.detail,
        "timestamp": _isoformat(record.timestamp),
    }
    if record.status:
        payload["status"] = record.status
    return payload


def serialize_browser_context(
    session_record: BrowserSessionRecord | None,
    actions: list[BrowserActionRecord] | None = None,
) -> dict[str, object]:
    if session_record is None:
        context = dict(IDLE_BROWSER_CONTEXT)
        context["lastUpdated"] = _isoformat(datetime.now(timezone.utc))
        return context

    return {
        "url": session_record.current_url,
        "title": session_record.title,
        "summary": session_record.summary,
        "status": session_record.status if session_record.status in {"idle", "navigating", "executing", "blocked"} else "idle",
        "lastUpdated": _isoformat(session_record.last_updated),
        "activeTask": session_record.active_task,
        "tabLabel": session_record.tab_label,
        "domSnippet": session_record.dom_snippet or "",
        "previewUrl": session_record.preview_url,
        "screenshotUrl": session_record.screenshot_url,
        "recentActions": [_serialize_action(action) for action in actions or []],
    }


def get_browser_session(session: Session, browser_session_id: str) -> BrowserSessionRecord | None:
    return session.get(BrowserSessionRecord, browser_session_id)


def get_latest_browser_session(session: Session) -> BrowserSessionRecord | None:
    statement = select(BrowserSessionRecord).order_by(desc(BrowserSessionRecord.last_updated)).limit(1)
    return session.exec(statement).first()


def get_reusable_browser_session(session: Session, idle_window_seconds: int) -> BrowserSessionRecord | None:
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=idle_window_seconds)
    statement = (
        select(BrowserSessionRecord)
        .where(BrowserSessionRecord.browser_use_session_id.is_not(None))
        .where(BrowserSessionRecord.last_updated >= cutoff)
        .order_by(desc(BrowserSessionRecord.last_updated))
        .limit(1)
    )
    return session.exec(statement).first()


def append_browser_action(
    session: Session,
    *,
    browser_session_id: str,
    kind: str,
    detail: str,
    status: str | None = None,
) -> BrowserActionRecord:
    record = BrowserActionRecord(
        session_id=browser_session_id,
        kind=kind,
        detail=detail,
        status=status,
    )
    session.add(record)
    session.commit()
    session.refresh(record)

    stale_actions = list(
        session.exec(
            select(BrowserActionRecord)
            .where(BrowserActionRecord.session_id == browser_session_id)
            .order_by(desc(BrowserActionRecord.timestamp))
            .offset(12)
        )
    )
    if stale_actions:
        stale_ids = [action.id for action in stale_actions]
        session.exec(delete(BrowserActionRecord).where(BrowserActionRecord.id.in_(stale_ids)))
        session.commit()

    return record


def get_recent_actions(session: Session, browser_session_id: str, limit: int = 10) -> list[BrowserActionRecord]:
    statement = (
        select(BrowserActionRecord)
        .where(BrowserActionRecord.session_id == browser_session_id)
        .order_by(desc(BrowserActionRecord.timestamp))
        .limit(limit)
    )
    actions = list(session.exec(statement))
    actions.reverse()
    return actions


def begin_browser_task(
    session: Session,
    *,
    task: str,
    profile_id: str | None,
    idle_window_seconds: int,
) -> BrowserSessionRecord:
    record = get_reusable_browser_session(session, idle_window_seconds)
    if record is None:
        record = BrowserSessionRecord(profile_id=profile_id)
    else:
        record.profile_id = profile_id or record.profile_id

    record.status = "executing"
    record.summary = "Browser task queued."
    record.active_task = task
    record.last_updated = datetime.now(timezone.utc)
    session.add(record)
    session.commit()
    session.refresh(record)
    return record


def update_browser_session(
    session: Session,
    *,
    browser_session_id: str,
    status: str,
    summary: str,
    active_task: str | None,
    browser_use_session_id: str | None = None,
    profile_id: str | None = None,
    current_url: str | None = None,
    title: str | None = None,
    tab_label: str | None = None,
    preview_url: str | None = None,
    screenshot_url: str | None = None,
    dom_snippet: str | None = None,
) -> BrowserSessionRecord:
    record = session.get(BrowserSessionRecord, browser_session_id)
    if record is None:
        raise ValueError(f"Unknown browser session: {browser_session_id}")

    record.status = status
    record.summary = summary
    record.active_task = active_task
    record.last_updated = datetime.now(timezone.utc)
    if browser_use_session_id is not None:
        record.browser_use_session_id = browser_use_session_id
    if profile_id is not None:
        record.profile_id = profile_id
    if current_url is not None:
        record.current_url = current_url
    if title is not None:
        record.title = title
    if tab_label is not None:
        record.tab_label = tab_label
    if preview_url is not None:
        record.preview_url = preview_url
    if screenshot_url is not None:
        record.screenshot_url = screenshot_url
    if dom_snippet is not None:
        record.dom_snippet = dom_snippet

    session.add(record)
    session.commit()
    session.refresh(record)
    return record


def get_current_browser_context(session: Session) -> dict[str, object]:
    record = get_latest_browser_session(session)
    if record is None:
        return serialize_browser_context(None)
    actions = get_recent_actions(session, record.id)
    return serialize_browser_context(record, actions)
