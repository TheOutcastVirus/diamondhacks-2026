from __future__ import annotations

import importlib
import time
from pathlib import Path

from fastapi.testclient import TestClient


def build_client(tmp_path: Path) -> TestClient:
    import os

    os.environ["DATABASE_URL"] = f"sqlite:///{tmp_path / 'test.db'}"
    os.environ["BROWSER_USE_MOCK_MODE"] = "true"
    os.environ["BROWSER_USE_API_KEY"] = ""

    from app import config, db, main

    config.reset_settings_cache()
    db.reset_engine_cache()
    main = importlib.reload(main)

    return TestClient(main.app)


def test_reminders_round_trip(tmp_path: Path) -> None:
    client = build_client(tmp_path)

    with client:
        response = client.get("/api/reminders")
        assert response.status_code == 200
        assert response.json() == {"reminders": []}

        created = client.post(
            "/api/reminders",
            json={
                "title": "Hydration reminder",
                "instructions": "Prompt for water.",
                "cadence": "daily",
                "cron": "0 15 * * *",
                "scheduleLabel": "Every day at 15:00",
                "timezone": "America/Los_Angeles",
            },
        )
        assert created.status_code == 200
        payload = created.json()
        assert payload["title"] == "Hydration reminder"
        assert payload["scheduleLabel"] == "Every day at 15:00"
        assert payload["nextRun"]

        listed = client.get("/api/reminders")
        assert listed.status_code == 200
        assert len(listed.json()["reminders"]) == 1


def test_transcript_history_and_stream_endpoint(tmp_path: Path) -> None:
    client = build_client(tmp_path)

    with client:
        route_paths = {route.path for route in client.app.routes}
        assert "/api/transcript/stream" in route_paths

        response = client.post(
            "/api/agent/turn",
            json={"message": "Please note this for later.", "source": "guardian", "forceBrowser": False},
        )
        assert response.status_code == 200
        assert response.json()["route"] == "conversation"

        transcript = client.get("/api/transcript")
        assert transcript.status_code == 200
        entries = transcript.json()["entries"]
        assert len(entries) == 2
        assert entries[0]["text"] == "Please note this for later."
        assert entries[1]["role"] == "robot"


def test_browser_task_updates_state(tmp_path: Path) -> None:
    client = build_client(tmp_path)

    with client:
        response = client.post(
            "/api/agent/turn",
            json={"message": "Find the nearest pharmacy hours in the browser.", "source": "dashboard"},
        )
        assert response.status_code == 200
        assert response.json()["route"] == "browser_task"

        time.sleep(0.8)

        browser = client.get("/api/browser")
        assert browser.status_code == 200
        payload = browser.json()["browser"]
        assert payload["status"] == "idle"
        assert payload["recentActions"]
        assert "Mock browser run completed" in payload["summary"]
