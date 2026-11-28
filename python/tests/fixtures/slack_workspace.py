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

from collections.abc import AsyncIterator
from typing import Any
from urllib.parse import parse_qsl

import pytest_asyncio

from mirage.accessor.slack import SlackAccessor
from mirage.vfs.slack.config import SlackConfig
from tests.fixtures.kit_fake import KitRun

TEAM = "unit"
# The bot, in every conversation the fixture holds.
TOKEN = f"xoxb-{TEAM}"
# A user token naming no one, which the fake reads as the installing user:
# in every conversation, and allowed to search.
USER_TOKEN = f"xoxp-{TEAM}"
# ben's user token: he is in general only, not in the private random or in
# ana's DM.
SEARCHER = f"xoxp-{TEAM}.U2"
FIXTURE = "unit"
HISTORY = "/api/conversations.history"
LISTING = "/api/conversations.list"
EMOJI = "/api/emoji.list"
POST = "/api/chat.postMessage"
UPDATE = "/api/chat.update"
DELETE = "/api/chat.delete"
PINS_ADD = "/api/pins.add"
PINS_REMOVE = "/api/pins.remove"
PINS = "/api/pins.list"
REACT = "/api/reactions.add"
REACTIONS = "/api/reactions.get"
UPLOAD_URL = "/api/files.getUploadURLExternal"
UPLOAD = "/upload/:id"
COMPLETE = "/api/files.completeUploadExternal"
USERS = "/api/users.list"
AUTH = "/api/auth.test"
SEARCH_MESSAGES = "/api/search.messages"
SEARCH_FILES = "/api/search.files"
DOWNLOAD = "/files/download/:id"


class SlackWorkspace:
    """One Slack workspace on the integ Slack fake, in the world the unit
    fixture seeds, and the reads a test checks it by.

    The world (integ/fixtures/slack/unit.json): ana (U1) and ben (U2);
    general (C1) holds both, random (C2) is private to ana, D1 is ana's
    DM; plan.txt is uploaded in general on 2025-11-05 and shared again
    in random on 2025-11-07.

    Args:
        origin (str): the Slack fake's origin.
    """

    def __init__(self, origin: str) -> None:
        self.run = KitRun(origin, {"Authorization": f"Bearer {TOKEN}"})

    async def reset(self, fixture: str = FIXTURE) -> None:
        """Seed the run afresh with a fixture's world and record its
        requests, with the token each sent.

        Args:
            fixture (str): the fixture under integ/fixtures/slack/.
        """
        await self.run.call(
            "POST", "/reset", json={"fixture": fixture, "tenants": [TEAM]}
        )
        await self.record()

    async def record(self) -> None:
        """Start listing requests afresh, with the token each sent."""
        await self.run.record_requests("authorization")

    def fields(self, **overrides: Any) -> dict[str, Any]:
        """A mount config's fields on the workspace, as the user token.

        Args:
            **overrides (Any): config fields to set or replace.
        """
        return {"token": USER_TOKEN, "base_url": f"{self.run.url}/api"} | (
            overrides
        )

    def config(self, **overrides: Any) -> SlackConfig:
        """A mount config on the workspace.

        Args:
            **overrides (Any): config fields to set or replace.
        """
        return SlackConfig(**self.fields(**overrides))

    def accessor(self, **overrides: Any) -> SlackAccessor:
        """A Mirage accessor on the workspace.

        Args:
            **overrides (Any): config fields to set or replace.
        """
        return SlackAccessor(self.config(**overrides))

    async def searches(self) -> list[str]:
        """The query of each search since recording started, in order."""
        listed = await self.run.call("GET", "/_kit/requests")
        return [
            dict(parse_qsl(r["query"], keep_blank_values=True))["query"]
            for r in listed["requests"]
            if r["route"] in (SEARCH_MESSAGES, SEARCH_FILES)
        ]

    async def count(self, route: str, token: str | None = None) -> int:
        """How many requests went to ``route`` since recording started.

        Args:
            route (str): the route as the fake declares it.
            token (str | None): only those sent with this token; any if
                None.
        """
        listed = await self.run.call("GET", "/_kit/requests")
        return sum(
            1
            for r in listed["requests"]
            if r["route"] == route
            and (
                token is None
                or r["headers"].get("authorization") == f"Bearer {token}"
            )
        )

    async def post(self, channel: str, text: str) -> str:
        """Post a message as the bot, from another client, and its ts.

        Args:
            channel (str): the conversation's id.
            text (str): the message's text.
        """
        done = await self.run.call(
            "POST", POST, json={"channel": channel, "text": text}
        )
        assert done["ok"], done
        return done["ts"]

    async def history(self, channel: str) -> list[dict[str, Any]]:
        """A conversation's messages, newest first, as Slack answers.

        Args:
            channel (str): the conversation's id.
        """
        page = await self.run.call(
            "GET", HISTORY, params={"channel": channel, "limit": "1000"}
        )
        return page["messages"]

    async def pin(self, channel: str, ts: str) -> None:
        """Pin a message as another client would.

        Args:
            channel (str): the conversation's id.
            ts (str): the message's ts.
        """
        done = await self.run.call(
            "POST", PINS_ADD, json={"channel": channel, "timestamp": ts}
        )
        assert done["ok"], done

    async def first_page(self, route: str, size: int, **params: str) -> None:
        """Answer the next request to ``route`` with the fake's own first
        page of ``size`` rows, so the listing goes on by its cursor.

        Slack may answer fewer rows than a request's ``limit``, and Mirage
        asks for 200, more than the unit world holds.

        Args:
            route (str): the route as the fake declares it.
            size (int): the rows the first page holds.
            **params (str): the listing's other arguments.
        """
        own = await self.run.call(
            "GET", route, params={**params, "limit": str(size)}
        )
        await self.run.answer_next("GET", route, 200, own)

    async def answer_auth(self, **fields: Any) -> None:
        """Answer every auth.test with the fake's own answer, ``fields``
        changed.

        Args:
            **fields (Any): the fields to set, as Slack names them.
        """
        own = await self.run.call("GET", AUTH)
        await self.run.answer_next(
            "GET", AUTH, 200, own | fields, times=1_000_000
        )

    async def close(self) -> None:
        """Drop the run."""
        await self.run.close()


@pytest_asyncio.fixture
async def slack_workspace(slack_origin: str) -> AsyncIterator[SlackWorkspace]:
    """A Slack workspace of the test's own, seeded with the unit world."""
    workspace = SlackWorkspace(slack_origin)
    await workspace.reset()
    yield workspace
    await workspace.close()
