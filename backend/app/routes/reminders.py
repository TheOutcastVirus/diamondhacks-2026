from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session

from ..db import get_session
from ..schemas import ReminderCreate
from ..services.reminders import create_reminder, list_reminders, serialize_reminder


router = APIRouter(prefix="/api/reminders", tags=["reminders"])


@router.get("")
async def get_reminders(session: Session = Depends(get_session)) -> dict[str, object]:
    reminders = [serialize_reminder(reminder) for reminder in list_reminders(session)]
    return {"reminders": reminders}


@router.post("")
async def post_reminder(payload: ReminderCreate, session: Session = Depends(get_session)) -> dict[str, object]:
    try:
        reminder = create_reminder(session, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return serialize_reminder(reminder)
