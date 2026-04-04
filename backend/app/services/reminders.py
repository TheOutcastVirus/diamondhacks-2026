from __future__ import annotations

from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from croniter import croniter
from sqlmodel import Session, select

from ..models import ReminderRecord
from ..schemas import ReminderCreate


def _normalize_timezone(timezone_name: str) -> ZoneInfo:
    try:
        return ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError as exc:
        raise ValueError(f"Unknown timezone: {timezone_name}") from exc


def _format_iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def compute_next_run(cron_expression: str, timezone_name: str, base_time: datetime | None = None) -> datetime:
    if not croniter.is_valid(cron_expression):
        raise ValueError("Invalid cron expression.")

    tz = _normalize_timezone(timezone_name)
    localized_base = (base_time or datetime.now(timezone.utc)).astimezone(tz)
    next_run_local = croniter(cron_expression, localized_base).get_next(datetime)
    return next_run_local.astimezone(timezone.utc)


def serialize_reminder(record: ReminderRecord) -> dict[str, object]:
    return {
        "id": record.id,
        "title": record.title,
        "instructions": record.instructions,
        "cron": record.cron,
        "cadence": record.cadence,
        "scheduleLabel": record.schedule_label,
        "nextRun": _format_iso(record.next_run),
        "status": record.status,
        "owner": record.owner,
        "timezone": record.timezone,
    }


def list_reminders(session: Session) -> list[ReminderRecord]:
    statement = select(ReminderRecord).order_by(ReminderRecord.created_at.desc())
    return list(session.exec(statement))


def create_reminder(session: Session, payload: ReminderCreate) -> ReminderRecord:
    next_run = compute_next_run(payload.cron, payload.timezone)
    record = ReminderRecord(
        title=payload.title.strip(),
        instructions=payload.instructions.strip(),
        cadence=payload.cadence,
        cron=payload.cron,
        schedule_label=payload.schedule_label,
        next_run=next_run,
        timezone=payload.timezone,
    )
    session.add(record)
    session.commit()
    session.refresh(record)
    return record
