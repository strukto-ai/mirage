# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import base64
import json
import math
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

from pydantic import BaseModel, Field

from mirage.server.schemas import Instant
from mirage.utils.dates import ms_to_rfc3339
from mirage.utils.ids import check_name


class LogMount(BaseModel):
    op: str
    path: str
    source: str
    bytes: int | None
    started_at: Instant = Field(description="When it started.")
    duration_ms: float


class CommandLog(BaseModel):
    id: str
    command: str
    cwd: str | None
    started_at: Instant = Field(description="When it started.")
    duration_ms: float
    exit_code: int | None
    stdout: str
    stderr: str
    user_id: str | None
    api_key_id: str | None
    mounts: list[LogMount]


class LogPage(BaseModel):
    items: list[CommandLog]
    next: str | None


@dataclass
class LoggedCommand:
    item: CommandLog
    records: list[dict[str, Any]]
    timestamp: int


def session_filter(session: str | None) -> str | None:
    if session in (None, ""):
        return None
    check_name("session id", session)
    return session


def log_attachment(workspace_id: str) -> str:
    filename = quote(f"{workspace_id}-logs.jsonl", safe="")
    return f"attachment; filename=\"logs.jsonl\"; filename*=UTF-8''{filename}"


def completed_logs(records: list[dict[str, Any]]) -> list[LoggedCommand]:
    results = {
        e["parent"]: e
        for e in records
        if e.get("type") == "result" and "parent" in e
    }
    calls: dict[str, list[dict[str, Any]]] = {}
    for event in records:
        if event.get("type") == "vfs" and "parent" in event:
            calls.setdefault(event["parent"], []).append(event)
    out = []
    for command in records:
        if (
            command.get("type") != "command"
            or command.get("id") not in results
        ):
            continue
        result = results[command["id"]]
        mounts = sorted(
            calls.get(command["id"], []),
            key=lambda e: e["timestamp"] - e.get("duration_ms", 0),
        )
        item = CommandLog(
            id=command["id"],
            command=command["command"],
            cwd=command.get("cwd"),
            started_at=ms_to_rfc3339(command["timestamp"]),
            duration_ms=result.get("duration_ms", 0),
            exit_code=result.get("exit_code"),
            stdout=result.get("stdout", ""),
            stderr=result.get("stderr", ""),
            user_id=None,
            api_key_id=None,
            mounts=[
                LogMount(
                    op=e["vfs"],
                    path=e["path"],
                    source=e.get("source", ""),
                    bytes=e.get("bytes"),
                    started_at=ms_to_rfc3339(
                        e["timestamp"] - e.get("duration_ms", 0)
                    ),
                    duration_ms=e.get("duration_ms", 0),
                )
                for e in mounts
            ],
        )
        out.append(
            LoggedCommand(
                item, [command, *mounts, result], command["timestamp"]
            )
        )
    return sorted(
        out, key=lambda log: (log.timestamp, log.item.id), reverse=True
    )


def log_page(
    logs: list[LoggedCommand], limit: str, after: str | None
) -> LogPage:
    try:
        count = float(limit.strip() or "0")
    except ValueError:
        raise ValueError("limit must be 1-200") from None
    if (
        not math.isfinite(count)
        or not count.is_integer()
        or not 1 <= count <= 200
    ):
        raise ValueError("limit must be 1-200")
    if after:
        try:
            timestamp, ident = json.loads(
                base64.b64decode(after, validate=True)
            )
            if (
                type(timestamp) is not int
                or timestamp < 0
                or not isinstance(ident, str)
                or not ident
            ):
                raise ValueError
        except (ValueError, TypeError, UnicodeError):
            raise ValueError("after is not a cursor") from None
        logs = [
            log
            for log in logs
            if (log.timestamp, log.item.id) < (timestamp, ident)
        ]
    picked = logs[: int(count)]
    cursor = None
    if len(logs) > count:
        last = picked[-1]
        cursor = base64.b64encode(
            json.dumps(
                [last.timestamp, last.item.id], separators=(",", ":")
            ).encode()
        ).decode()
    return LogPage(items=[log.item for log in picked], next=cursor)


def log_lines(logs: list[LoggedCommand]) -> Iterator[str]:
    for log in reversed(logs):
        for record in log.records:
            shown = {**record, "timestamp": ms_to_rfc3339(record["timestamp"])}
            yield (
                json.dumps(shown, ensure_ascii=False, separators=(",", ":"))
                + "\n"
            )
