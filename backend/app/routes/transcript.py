from __future__ import annotations

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from sqlmodel import Session

from ..db import get_session
from ..services.transcript_bus import list_transcript_entries, transcript_bus


router = APIRouter(prefix="/api/transcript", tags=["transcript"])


@router.get("")
async def get_transcript(session: Session = Depends(get_session)) -> dict[str, object]:
    return {"entries": list_transcript_entries(session)}


@router.get("/stream")
async def stream_transcript() -> StreamingResponse:
    return StreamingResponse(
        transcript_bus.stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
