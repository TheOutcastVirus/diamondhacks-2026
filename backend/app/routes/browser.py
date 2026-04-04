from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlmodel import Session

from ..db import get_session
from ..services.browser_state import get_current_browser_context


router = APIRouter(prefix="/api/browser", tags=["browser"])


@router.get("")
async def get_browser_context(session: Session = Depends(get_session)) -> dict[str, object]:
    return {"browser": get_current_browser_context(session)}
