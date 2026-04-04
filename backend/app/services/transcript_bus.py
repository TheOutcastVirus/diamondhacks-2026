from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from datetime import timezone

from sqlmodel import Session, select

from ..models import TranscriptEntryRecord


def _isoformat(value):
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


class TranscriptEventBus:
    def __init__(self) -> None:
        self._queues: set[asyncio.Queue[tuple[str, dict[str, object]]]] = set()
        self._lock = asyncio.Lock()

    async def subscribe(self) -> asyncio.Queue[tuple[str, dict[str, object]]]:
        queue: asyncio.Queue[tuple[str, dict[str, object]]] = asyncio.Queue(maxsize=100)
        async with self._lock:
            self._queues.add(queue)
        return queue

    async def unsubscribe(self, queue: asyncio.Queue[tuple[str, dict[str, object]]]) -> None:
        async with self._lock:
            self._queues.discard(queue)

    async def publish(self, event_type: str, payload: dict[str, object]) -> None:
        async with self._lock:
            queues = list(self._queues)

        for queue in queues:
            try:
                queue.put_nowait((event_type, payload))
            except asyncio.QueueFull:
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                queue.put_nowait((event_type, payload))

    async def stream(self) -> AsyncIterator[str]:
        queue = await self.subscribe()
        try:
            while True:
                try:
                    event_type, payload = await asyncio.wait_for(queue.get(), timeout=15)
                    yield f"event: {event_type}\ndata: {json.dumps(payload)}\n\n"
                except TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            await self.unsubscribe(queue)


transcript_bus = TranscriptEventBus()


def serialize_transcript_entry(record: TranscriptEntryRecord) -> dict[str, object]:
    metadata = json.loads(record.metadata_json) if record.metadata_json else None
    payload: dict[str, object] = {
        "id": record.id,
        "timestamp": _isoformat(record.timestamp),
        "kind": record.kind,
        "role": record.role,
        "text": record.text,
    }
    if record.tool_name:
        payload["toolName"] = record.tool_name
    if record.tool_status:
        payload["toolStatus"] = record.tool_status
    if metadata is not None:
        payload["metadata"] = metadata
    return payload


def create_transcript_entry(
    session: Session,
    *,
    kind: str,
    role: str,
    text: str,
    tool_name: str | None = None,
    tool_status: str | None = None,
    metadata: dict[str, object] | None = None,
) -> dict[str, object]:
    record = TranscriptEntryRecord(
        kind=kind,
        role=role,
        text=text,
        tool_name=tool_name,
        tool_status=tool_status,
        metadata_json=json.dumps(metadata) if metadata is not None else None,
    )
    session.add(record)
    session.commit()
    session.refresh(record)
    return serialize_transcript_entry(record)


def list_transcript_entries(session: Session) -> list[dict[str, object]]:
    statement = select(TranscriptEntryRecord).order_by(TranscriptEntryRecord.timestamp.asc())
    return [serialize_transcript_entry(entry) for entry in session.exec(statement)]
