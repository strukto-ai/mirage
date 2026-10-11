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

import asyncio
import re
from typing import Any

import pytest

import mirage.core.slack.read as read_mod
from mirage.types import MountMode
from mirage.vfs.slack.config import SlackConfig
from mirage.vfs.slack.slack import SlackVFS
from mirage.workspace.workspace import Workspace

DAY = 86_400
START = 1762128000
CHANNELS = [
    {"id": "C1", "name": "general", "created": START},
    {"id": "C2", "name": "random", "created": START},
]
DMS = [{"id": "D1", "user": "U1", "created": START}]
SEARCHER = "xoxp-searcher"
PROFILE = {"real_name": "Ana Lima", "display_name": "ana"}
USERS = [
    {"id": "U1", "name": "ana", "real_name": "Ana Lima", "profile": PROFILE}
]
PLAN = {
    "id": "F1",
    "name": "plan.txt",
    "title": "Launch plan",
    "mimetype": "text/plain",
    "filetype": "text",
    "size": 5,
    "timestamp": START + 2 * DAY + 60,
    "url_private_download": "https://files.slack.com/files-pri/T1-F1/download/plan.txt",
    "permalink": "https://acme.slack.com/files/U1/F1/plan.txt",
}


def _message(at: int, text: str, **extra: Any) -> dict[str, Any]:
    return {
        "type": "message",
        "user": "U1",
        "text": text,
        "ts": f"{at}.000001",
    } | extra


MESSAGES = {
    "C1": [
        _message(START + 60, "the deploy is done at acme"),
        _message(
            START + DAY + 60,
            "lunch at noon",
            reactions=[{"name": "rocket", "users": ["U1"], "count": 1}],
        ),
        _message(START + 2 * DAY + 60, "", files=[PLAN]),
        _message(START + 3 * DAY + 60, "deploy again", user_profile=PROFILE),
    ],
    "C2": [
        _message(START + DAY + 60, "a random deploy in Lima"),
        _message(START + 4 * DAY + 60, "", files=[PLAN]),
    ],
    "D1": [_message(START + 60, "deploy in a dm")],
}


def _holds(text: str, word: str) -> bool:
    return (
        re.search(
            rf"(?<!\w){re.escape(word)}(?!\w)", text, flags=re.IGNORECASE
        )
        is not None
    )


class FakeSlack:
    """The Slack Web API a channel walk and its search reach.

    Search matches whole words in any case, as Slack does: message text
    (``search.messages``), a reaction name (``has::name:``) and a file's
    name or title (``search.files``, naming every message that shares it
    unless ``shares`` is off), scoped by ``in:#name``. Every page answers
    ``pages`` as its page count; a search raises ``fails`` when set. The
    ``hidden`` channels are private ones the ``SEARCHER`` token's user is
    not in: that user neither lists nor finds them. Each call yields to
    the loop once, as a request does.
    """

    def __init__(
        self,
        pages: int = 1,
        fails: Exception | None = None,
        shares: bool = True,
        hidden: frozenset[str] = frozenset(),
    ) -> None:
        self.pages = pages
        self.fails = fails
        self.shares = shares
        self.hidden = hidden
        self.searches: list[str] = []
        self.user_lists = 0
        self.searcher_lists = 0

    async def get(self, config, method, params=None, session=None):
        await asyncio.sleep(0)
        params = params or {}
        if method == "conversations.list":
            channels = DMS if "im" in params["types"] else CHANNELS
            if config.token.get_secret_value() == SEARCHER:
                self.searcher_lists += 1
                channels = [c for c in channels if c["id"] not in self.hidden]
            return {"ok": True, "channels": channels}
        if method == "users.list":
            self.user_lists += 1
            return {"ok": True, "members": USERS}
        if method == "auth.test":
            return {"ok": True, "url": "https://acme.slack.com/"}
        if method == "conversations.history":
            oldest = float(params.get("oldest", 0))
            latest = float(params.get("latest", "inf"))
            found = [
                m
                for m in reversed(MESSAGES[params["channel"]])
                if oldest <= float(m["ts"]) <= latest
            ]
            return {"ok": True, "messages": found[: int(params["limit"])]}
        self.searches.append(params["query"])
        if self.fails is not None:
            raise self.fails
        return {
            "ok": True,
            method.removeprefix("search."): self._search(
                method, params["query"]
            ),
        }

    def _search(self, method: str, query: str) -> dict[str, Any]:
        words = query.split()
        names = [w.removeprefix("in:#") for w in words if w.startswith("in:#")]
        reaction = [w[5:-1] for w in words if w.startswith("has::")]
        text = " ".join(
            w for w in words if not w.startswith(("in:#", "has::"))
        )
        ids = [
            c["id"]
            for c in CHANNELS
            if (not names or c["name"] in names) and c["id"] not in self.hidden
        ]
        if not names:
            ids.append("D1")
        matches: list[dict[str, Any]] = []
        for cid in ids:
            for m in MESSAGES[cid]:
                if (
                    method == "search.messages"
                    and m["text"]
                    and (
                        any(
                            r["name"] in reaction
                            for r in m.get("reactions", [])
                        )
                        if reaction
                        else _holds(m["text"], text)
                    )
                ):
                    matches.append({"ts": m["ts"], "channel": {"id": cid}})
                if method == "search.files" and not reaction:
                    matches.extend(
                        self._file(f)
                        for f in m.get("files", [])
                        if _holds(f["name"], text) or _holds(f["title"], text)
                    )
        return {"matches": matches, "paging": {"pages": self.pages}}

    def _file(self, file: dict[str, Any]) -> dict[str, Any]:
        found = {"id": file["id"], "timestamp": file["timestamp"]}
        if not self.shares:
            return found
        shares: dict[str, dict[str, list[dict[str, str]]]] = {}
        for cid, messages in MESSAGES.items():
            for m in messages:
                if any(f["id"] == file["id"] for f in m.get("files", [])):
                    kind = "private" if cid.startswith("D") else "public"
                    rows = shares.setdefault(kind, {}).setdefault(cid, [])
                    rows.append({"ts": m["ts"]})
        return found | {"shares": shares}

    async def download(self, config, url, offset=0, size=None, session=None):
        return b"plan\n"

    async def download_stream(self, config, url, session=None):
        yield b"plan\n"


@pytest.fixture
def slack(monkeypatch):
    """Run a line over a Slack mount served by a ``FakeSlack``.

    Returns:
        an async ``run(line, fake=None, **config)`` giving the output, the
        exit code, the channel days read and the queries searched.
    """

    async def run(line: str, fake: FakeSlack | None = None, **config: Any):
        fake = fake or FakeSlack()
        for module in ("paginate", "readdir", "search"):
            monkeypatch.setattr(
                f"mirage.core.slack.{module}.slack_get", fake.get
            )
        monkeypatch.setattr(read_mod, "download_file", fake.download)
        monkeypatch.setattr(
            read_mod, "download_file_stream", fake.download_stream
        )
        reads: list[str] = []
        history = read_mod.get_history_jsonl

        async def counted(config, channel_id, day, *args, **kwargs):
            reads.append(f"{channel_id}/{day}")
            return await history(config, channel_id, day, *args, **kwargs)

        monkeypatch.setattr(read_mod, "get_history_jsonl", counted)
        settings = {"token": "xoxp-test", "content_search": True} | config
        ws = Workspace(
            {"/slack": SlackVFS(SlackConfig(**settings))}, mode=MountMode.READ
        )
        try:
            result = await ws.shell(line)
            out = await result.stdout_str()
        finally:
            await ws.close()
        return out, result.exit_code, sorted(reads), fake.searches

    return run
