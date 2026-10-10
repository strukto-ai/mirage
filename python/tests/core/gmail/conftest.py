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
import re
from datetime import datetime
from typing import Any

import aiohttp
import pytest
from multidict import CIMultiDict, CIMultiDictProxy
from yarl import URL

import mirage.core.gmail.read as read_mod
import mirage.core.gmail.readdir as readdir_mod
import mirage.core.gmail.search as search_mod
from mirage.types import MountMode
from mirage.vfs.gmail.config import GmailConfig
from mirage.vfs.gmail.gmail import GmailVFS
from mirage.workspace import Workspace

LABELS = [
    {"id": "INBOX", "name": "INBOX", "type": "system"},
    {"id": "TRASH", "name": "TRASH", "type": "system"},
    {"id": "Label_1", "name": "Work", "type": "user"},
]


def _message(
    mid: str,
    labels: list[str],
    day: str,
    sender: str,
    subject: str,
    body: str,
    attachment: str = "",
) -> dict[str, Any]:
    at = datetime.fromisoformat(f"{day}T09:00:00+00:00")
    parts: list[dict[str, Any]] = [
        {
            "mimeType": "text/plain",
            "body": {"data": base64.urlsafe_b64encode(body.encode()).decode()},
        }
    ]
    if attachment:
        parts.append(
            {
                "filename": attachment,
                "mimeType": "text/plain",
                "body": {"attachmentId": f"A{mid}", "size": 5},
            }
        )
    return {
        "id": mid,
        "threadId": mid,
        "labelIds": labels,
        "internalDate": str(int(at.timestamp() * 1000)),
        "snippet": body,
        "payload": {
            "mimeType": "multipart/mixed",
            "headers": [
                {"name": "From", "value": sender},
                {"name": "To", "value": "me@example.com"},
                {"name": "Subject", "value": subject},
                {"name": "Date", "value": "Mon, 5 Jan 2026 09:00:00 +0000"},
            ],
            "parts": parts,
        },
    }


MESSAGES = [
    _message(
        "a1",
        ["INBOX"],
        "2026-01-05",
        "Ana Lima <ana@example.com>",
        "Budget review",
        "numbers for travel",
        attachment="plan.txt",
    ),
    _message(
        "b2",
        ["INBOX", "Label_1"],
        "2026-01-06",
        "Bo <bo@example.com>",
        "Lunch",
        "deploy friday",
    ),
    _message(
        "c3", ["TRASH"], "2026-01-06", "Cy <cy@example.com>", "Old", "deploy"
    ),
    _message(
        "d4", ["INBOX"], "2026-01-07", "Di <di@example.com>", "Notes", "quiet"
    ),
]


def _holds(text: str, word: str) -> bool:
    pattern = rf"(?<![A-Za-z0-9]){re.escape(word)}(?![A-Za-z0-9])"
    return re.search(pattern, text, flags=re.IGNORECASE) is not None


def _header(message: dict[str, Any], name: str) -> str:
    headers = message["payload"]["headers"]
    return next((h["value"] for h in headers if h["name"] == name), "")


class FakeGmail:
    """The Gmail API a label walk and its search reach.

    A bare word matches whole words of the From, To, Cc and Subject
    headers and the body in any case, ``filename:`` an attachment name,
    and ``after:``/``before:`` take epoch seconds, as Gmail does.
    """

    def __init__(self, fails: bool = False) -> None:
        self.fails = fails
        self.searches: list[str] = []

    async def list_labels(self, token_manager):
        return LABELS

    async def list_messages(
        self, token_manager, label_id=None, query=None, max_results=50
    ):
        if query is not None and not query.startswith("after:"):
            self.searches.append(query)
            if self.fails:
                raise aiohttp.ClientResponseError(
                    aiohttp.RequestInfo(
                        URL("https://gmail.test"),
                        "GET",
                        CIMultiDictProxy(CIMultiDict()),
                    ),
                    (),
                    status=429,
                )
        found = [
            {"id": m["id"], "threadId": m["threadId"]}
            for m in MESSAGES
            if (label_id is None or label_id in m["labelIds"])
            and self._matches(m, query or "")
        ]
        return found[:max_results]

    def _matches(self, message: dict[str, Any], query: str) -> bool:
        seconds = int(message["internalDate"]) // 1000
        for term in query.split():
            if term.startswith("after:"):
                if seconds <= int(term[6:]):
                    return False
            elif term.startswith("before:"):
                if seconds >= int(term[7:]):
                    return False
            elif term.startswith("filename:"):
                names = [
                    p.get("filename", "") for p in message["payload"]["parts"]
                ]
                if not any(_holds(name, term[9:]) for name in names):
                    return False
            else:
                headers = [
                    _header(message, name)
                    for name in ("From", "To", "Cc", "Subject")
                ]
                body = base64.urlsafe_b64decode(
                    message["payload"]["parts"][0]["body"]["data"]
                ).decode()
                if not any(_holds(text, term) for text in [*headers, body]):
                    return False
        return True

    async def get_message_raw(self, token_manager, message_id):
        return next(m for m in MESSAGES if m["id"] == message_id)

    async def get_attachment(self, token_manager, message_id, attachment_id):
        return b"plan\n"


@pytest.fixture
def gmail(monkeypatch):
    """Run a line over a Gmail mount served by a ``FakeGmail``.

    Returns:
        an async ``run(line, fake=None, **config)`` giving the output, the
        exit code, the message ids read and the queries searched.
    """

    async def run(line: str, fake: FakeGmail | None = None, **config: Any):
        fake = fake or FakeGmail()
        monkeypatch.setattr(readdir_mod, "list_labels", fake.list_labels)
        monkeypatch.setattr(readdir_mod, "list_messages", fake.list_messages)
        monkeypatch.setattr(
            readdir_mod, "get_message_raw", fake.get_message_raw
        )
        monkeypatch.setattr(search_mod, "list_messages", fake.list_messages)
        monkeypatch.setattr(read_mod, "get_attachment", fake.get_attachment)
        reads: list[str] = []

        async def counted(token_manager, message_id):
            reads.append(message_id)
            return await fake.get_message_raw(token_manager, message_id)

        monkeypatch.setattr(read_mod, "get_message_raw", counted)
        settings = {"access_token": "t", "content_search": True} | config
        ws = Workspace(
            {"/gmail": GmailVFS(GmailConfig(**settings))}, mode=MountMode.READ
        )
        try:
            result = await ws.shell(line)
            out = await result.stdout_str()
        finally:
            await ws.close()
        return out, result.exit_code, sorted(reads), fake.searches

    return run
