from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

import httpx
from sqlmodel import Session

from ..config import get_settings
from ..db import get_engine
from ..schemas import BrowserTaskAction, BrowserTaskStructuredOutput
from .browser_state import append_browser_action, update_browser_session
from .transcript_bus import create_transcript_entry, transcript_bus

try:
    from browser_use_sdk.v3 import AsyncBrowserUse  # type: ignore
except ImportError:  # pragma: no cover
    AsyncBrowserUse = None


@dataclass
class BrowserRunResult:
    session_id: str | None
    summary: str
    title: str | None = None
    url: str | None = None
    tab_label: str | None = None
    dom_snippet: str | None = None
    preview_url: str | None = None
    screenshot_url: str | None = None
    recent_actions: list[BrowserTaskAction] | None = None
    total_cost_usd: str | None = None


class BrowserUseService:
    def __init__(self) -> None:
        self._stop_tasks: dict[str, asyncio.Task[None]] = {}

    @property
    def settings(self):
        return get_settings()

    def _can_use_cloud(self) -> bool:
        return bool(self.settings.browser_use_api_key and AsyncBrowserUse is not None)

    def _build_client(self):
        if AsyncBrowserUse is None:
            raise RuntimeError("browser-use-sdk is not installed.")
        return AsyncBrowserUse(
            api_key=self.settings.browser_use_api_key,
            base_url=self.settings.browser_use_base_url,
            timeout=60,
        )

    async def _get_session_view(self, session_id: str) -> dict[str, Any]:
        async with httpx.AsyncClient(
            base_url=self.settings.browser_use_base_url,
            headers={"X-Browser-Use-API-Key": self.settings.browser_use_api_key or ""},
            timeout=30,
        ) as client:
            response = await client.get(f"/sessions/{session_id}")
            response.raise_for_status()
            return response.json()

    async def _stop_cloud_session(self, session_id: str) -> None:
        async with httpx.AsyncClient(
            base_url=self.settings.browser_use_base_url,
            headers={"X-Browser-Use-API-Key": self.settings.browser_use_api_key or ""},
            timeout=30,
        ) as client:
            response = await client.post(f"/sessions/{session_id}/stop", params={"strategy": "session"})
            response.raise_for_status()

    def _cancel_idle_stop(self, session_id: str | None) -> None:
        if not session_id:
            return
        task = self._stop_tasks.pop(session_id, None)
        if task is not None:
            task.cancel()

    def _schedule_idle_stop(self, local_browser_session_id: str, remote_session_id: str | None) -> None:
        if not remote_session_id or self.settings.browser_use_idle_stop_seconds <= 0:
            return

        self._cancel_idle_stop(remote_session_id)

        async def _stop_later() -> None:
            try:
                await asyncio.sleep(self.settings.browser_use_idle_stop_seconds)
                if self._can_use_cloud():
                    await self._stop_cloud_session(remote_session_id)

                with Session(get_engine()) as session:
                    update_browser_session(
                        session,
                        browser_session_id=local_browser_session_id,
                        status="idle",
                        summary="Browser session saved after idle timeout.",
                        active_task=None,
                    )
                    append_browser_action(
                        session,
                        browser_session_id=local_browser_session_id,
                        kind="session",
                        detail="Stopped the Browser Use session after the idle window.",
                        status="completed",
                    )
            except asyncio.CancelledError:
                return
            except Exception:
                return
            finally:
                self._stop_tasks.pop(remote_session_id, None)

        self._stop_tasks[remote_session_id] = asyncio.create_task(_stop_later())

    def _coerce_structured_output(self, value: Any) -> BrowserTaskStructuredOutput:
        if isinstance(value, BrowserTaskStructuredOutput):
            return value
        if hasattr(value, "model_dump"):
            return BrowserTaskStructuredOutput.model_validate(value.model_dump(by_alias=True))
        if isinstance(value, dict):
            return BrowserTaskStructuredOutput.model_validate(value)
        return BrowserTaskStructuredOutput(summary=str(value))

    async def run_browser_task(
        self,
        *,
        browser_session_id: str,
        task: str,
        profile_id: str | None,
        remote_session_id: str | None,
    ) -> None:
        if self._can_use_cloud():
            await self._run_cloud_task(
                browser_session_id=browser_session_id,
                task=task,
                profile_id=profile_id,
                remote_session_id=remote_session_id,
            )
            return

        if self.settings.browser_use_mock_mode:
            await self._run_mock_task(browser_session_id=browser_session_id, task=task)
            return

        raise RuntimeError("Browser Use is not configured. Set BROWSER_USE_API_KEY or enable mock mode.")

    async def _run_cloud_task(
        self,
        *,
        browser_session_id: str,
        task: str,
        profile_id: str | None,
        remote_session_id: str | None,
    ) -> None:
        browser_client = self._build_client()
        effective_profile_id = profile_id or self.settings.browser_use_profile_id
        self._cancel_idle_stop(remote_session_id)

        with Session(get_engine()) as session:
            tool_event = create_transcript_entry(
                session,
                kind="tool",
                role="system",
                text=f"Started browser task: {task}",
                tool_name="browser-use",
                tool_status="started",
                metadata={"task": task},
            )
            append_browser_action(
                session,
                browser_session_id=browser_session_id,
                kind="dispatch",
                detail="Sent task to Browser Use Cloud.",
                status="pending",
            )
            update_browser_session(
                session,
                browser_session_id=browser_session_id,
                status="executing",
                summary="Browser Use is working on the task.",
                active_task=task,
                profile_id=effective_profile_id,
            )
        await transcript_bus.publish("tool", tool_event)

        try:
            run_kwargs: dict[str, Any] = {
                "task": task,
                "model": self.settings.browser_use_model,
                "output_schema": BrowserTaskStructuredOutput,
                "keep_alive": self.settings.browser_use_keep_alive,
                "max_cost_usd": self.settings.browser_use_max_cost_usd,
            }
            if effective_profile_id:
                run_kwargs["profile_id"] = effective_profile_id
            if self.settings.browser_use_proxy_country_code:
                run_kwargs["proxy_country_code"] = self.settings.browser_use_proxy_country_code
            if remote_session_id:
                run_kwargs["session_id"] = remote_session_id

            result = await browser_client.run(**run_kwargs)
            structured = self._coerce_structured_output(result.output)
            session_view = await self._get_session_view(str(result.id))

            browser_result = BrowserRunResult(
                session_id=str(result.id),
                summary=structured.summary,
                title=structured.title or session_view.get("title"),
                url=structured.url,
                tab_label=structured.tab_label or structured.title or session_view.get("title"),
                dom_snippet=structured.dom_snippet,
                preview_url=(
                    session_view.get("live_url")
                    or session_view.get("liveUrl")
                    or getattr(result, "live_url", None)
                    or getattr(result, "liveUrl", None)
                ),
                recent_actions=structured.recent_actions or [BrowserTaskAction(kind="complete", detail=structured.summary)],
                total_cost_usd=str(getattr(result, "total_cost_usd", "") or session_view.get("total_cost_usd", "")),
            )

            with Session(get_engine()) as session:
                update_browser_session(
                    session,
                    browser_session_id=browser_session_id,
                    status="idle",
                    summary=browser_result.summary,
                    active_task=task,
                    browser_use_session_id=browser_result.session_id,
                    profile_id=effective_profile_id,
                    current_url=browser_result.url or "No page loaded",
                    title=browser_result.title or "Browser task completed",
                    tab_label=browser_result.tab_label or "Active tab",
                    preview_url=browser_result.preview_url,
                    screenshot_url=browser_result.screenshot_url,
                    dom_snippet=browser_result.dom_snippet,
                )
                append_browser_action(
                    session,
                    browser_session_id=browser_session_id,
                    kind="session",
                    detail="Browser Use task completed successfully.",
                    status="completed",
                )
                for action in browser_result.recent_actions or []:
                    append_browser_action(
                        session,
                        browser_session_id=browser_session_id,
                        kind=action.kind,
                        detail=action.detail,
                        status=action.status,
                    )
                tool_complete = create_transcript_entry(
                    session,
                    kind="tool",
                    role="system",
                    text=browser_result.summary,
                    tool_name="browser-use",
                    tool_status="completed",
                    metadata={
                        "sessionId": browser_result.session_id,
                        "liveUrl": browser_result.preview_url,
                        "totalCostUsd": browser_result.total_cost_usd,
                    },
                )
                robot_reply = create_transcript_entry(
                    session,
                    kind="message",
                    role="robot",
                    text=browser_result.summary,
                )
            await transcript_bus.publish("tool", tool_complete)
            await transcript_bus.publish("transcript", robot_reply)
            self._schedule_idle_stop(browser_session_id, browser_result.session_id)
        except Exception as exc:
            message = f"Browser task failed: {exc}"
            with Session(get_engine()) as session:
                update_browser_session(
                    session,
                    browser_session_id=browser_session_id,
                    status="blocked",
                    summary=message,
                    active_task=task,
                    profile_id=effective_profile_id,
                )
                append_browser_action(
                    session,
                    browser_session_id=browser_session_id,
                    kind="error",
                    detail=message,
                    status="failed",
                )
                tool_error = create_transcript_entry(
                    session,
                    kind="tool",
                    role="system",
                    text=message,
                    tool_name="browser-use",
                    tool_status="failed",
                    metadata={"task": task},
                )
                robot_reply = create_transcript_entry(
                    session,
                    kind="message",
                    role="robot",
                    text="I couldn't complete that browser task. Check the guardian console for details.",
                )
            await transcript_bus.publish("tool", tool_error)
            await transcript_bus.publish("transcript", robot_reply)

    async def _run_mock_task(self, *, browser_session_id: str, task: str) -> None:
        with Session(get_engine()) as session:
            tool_event = create_transcript_entry(
                session,
                kind="tool",
                role="system",
                text=f"Started mock browser task: {task}",
                tool_name="browser-use",
                tool_status="started",
                metadata={"mode": "mock"},
            )
            append_browser_action(
                session,
                browser_session_id=browser_session_id,
                kind="dispatch",
                detail="Mock Browser Use session started.",
                status="pending",
            )
        await transcript_bus.publish("tool", tool_event)

        await asyncio.sleep(0.25)
        with Session(get_engine()) as session:
            update_browser_session(
                session,
                browser_session_id=browser_session_id,
                status="navigating",
                summary="Navigating through the requested website in mock mode.",
                active_task=task,
                current_url="https://example.com",
                title="Example Domain",
                tab_label="Example",
                dom_snippet="<main><h1>Example Domain</h1></main>",
            )
            append_browser_action(
                session,
                browser_session_id=browser_session_id,
                kind="navigate",
                detail="Opened a placeholder page while Browser Use mock mode simulates the run.",
                status="completed",
            )

        await asyncio.sleep(0.25)
        summary = f"Mock browser run completed for: {task}"
        with Session(get_engine()) as session:
            update_browser_session(
                session,
                browser_session_id=browser_session_id,
                status="idle",
                summary=summary,
                active_task=task,
                current_url="https://example.com",
                title="Example Domain",
                tab_label="Example",
                dom_snippet="<main><h1>Example Domain</h1><p>Mock Browser Use completed.</p></main>",
            )
            append_browser_action(
                session,
                browser_session_id=browser_session_id,
                kind="summary",
                detail=summary,
                status="completed",
            )
            tool_complete = create_transcript_entry(
                session,
                kind="tool",
                role="system",
                text=summary,
                tool_name="browser-use",
                tool_status="completed",
                metadata={"mode": "mock"},
            )
            robot_reply = create_transcript_entry(
                session,
                kind="message",
                role="robot",
                text=summary,
            )
        await transcript_bus.publish("tool", tool_complete)
        await transcript_bus.publish("transcript", robot_reply)


browser_use_service = BrowserUseService()
