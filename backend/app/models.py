from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from sqlmodel import Field, SQLModel


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def prefixed_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:12]}"


class ReminderRecord(SQLModel, table=True):
    __tablename__ = "reminders"

    id: str = Field(default_factory=lambda: prefixed_id("r"), primary_key=True)
    title: str
    instructions: str
    cadence: str = Field(default="weekly", index=True)
    cron: str
    schedule_label: str
    next_run: datetime | None = None
    status: str = Field(default="active", index=True)
    owner: str = Field(default="Gazabot agent")
    timezone: str = Field(default="UTC")
    created_at: datetime = Field(default_factory=utc_now, index=True)


class TranscriptEntryRecord(SQLModel, table=True):
    __tablename__ = "transcript_entries"

    id: str = Field(default_factory=lambda: prefixed_id("t"), primary_key=True)
    timestamp: datetime = Field(default_factory=utc_now, index=True)
    kind: str = Field(index=True)
    role: str = Field(index=True)
    text: str
    tool_name: str | None = None
    tool_status: str | None = None
    metadata_json: str | None = None


class BrowserSessionRecord(SQLModel, table=True):
    __tablename__ = "browser_sessions"

    id: str = Field(default_factory=lambda: prefixed_id("bs"), primary_key=True)
    browser_use_session_id: str | None = Field(default=None, index=True)
    profile_id: str | None = Field(default=None, index=True)
    status: str = Field(default="idle", index=True)
    current_url: str = Field(default="No page loaded")
    title: str = Field(default="Awaiting browser state")
    summary: str = Field(
        default="Once the backend exposes browser context, this page will mirror the active page, task, and recent browser actions."
    )
    active_task: str | None = Field(default="Waiting for browser automation")
    tab_label: str | None = Field(default="No active tab")
    preview_url: str | None = None
    screenshot_url: str | None = None
    dom_snippet: str | None = None
    last_updated: datetime = Field(default_factory=utc_now, index=True)


class BrowserActionRecord(SQLModel, table=True):
    __tablename__ = "browser_actions"

    id: str = Field(default_factory=lambda: prefixed_id("a"), primary_key=True)
    session_id: str = Field(index=True)
    kind: str
    detail: str
    timestamp: datetime = Field(default_factory=utc_now, index=True)
    status: str | None = None
