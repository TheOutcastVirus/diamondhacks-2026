from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class ReminderCreate(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    title: str
    instructions: str
    cadence: Literal["daily", "weekly", "custom"] = "weekly"
    cron: str
    schedule_label: str = Field(alias="scheduleLabel")
    timezone: str = "UTC"


class BrowserTaskAction(BaseModel):
    kind: str
    detail: str
    status: Literal["pending", "completed", "failed"] = "completed"


class BrowserTaskStructuredOutput(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    summary: str
    url: str | None = None
    title: str | None = None
    tab_label: str | None = Field(default=None, alias="tabLabel")
    dom_snippet: str | None = Field(default=None, alias="domSnippet")
    recent_actions: list[BrowserTaskAction] = Field(default_factory=list, alias="recentActions")


class AgentTurnRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    household_id: str | None = Field(default=None, alias="householdId")
    message: str
    source: Literal["voice", "dashboard", "resident", "guardian"] = "dashboard"
    profile_id: str | None = Field(default=None, alias="profileId")
    force_browser: bool | None = Field(default=None, alias="forceBrowser")
