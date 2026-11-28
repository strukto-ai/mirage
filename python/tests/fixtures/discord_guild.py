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

import json
from collections.abc import AsyncIterator
from datetime import date, datetime, timezone
from typing import Any
from urllib.parse import parse_qsl

import pytest_asyncio

from mirage.accessor.discord import DiscordAccessor
from mirage.core.discord.history import DISCORD_EPOCH, snowflake_at
from mirage.core.time_range import TimeRange
from mirage.vfs.discord.config import DiscordConfig
from tests.fixtures.kit_fake import KitRun

TOKEN = "unit-bot-token"
FIXTURE = "unit"
GUILD = "111"
GUILD_DIR = "My Server__111"
GENERAL = "211"
RANDOM = "212"
ALICE = "311"
BOB = "312"
# general's day of two messages: hello, then files with kept.txt and a
# tombstoned attachment.
DAY = "2024-01-15"
GUILDS = "/api/v10/users/@me/guilds"
CHANNELS = "/api/v10/guilds/:guild_id/channels"
MEMBERS = "/api/v10/guilds/:guild_id/members"
MEMBER_SEARCH = "/api/v10/guilds/:guild_id/members/search"
SEARCH = "/api/v10/guilds/:guild_id/messages/search"
MESSAGES = "/api/v10/channels/:channel_id/messages"
MESSAGE = "/api/v10/channels/:channel_id/messages/:message_id"
PINS = "/api/v10/channels/:channel_id/messages/pins"
PIN = "/api/v10/channels/:channel_id/messages/pins/:message_id"
THREADS = "/api/v10/channels/:channel_id/threads"
ATTACHMENT = "/attachments/:attachment_id/:filename"
UNTIL_CLEARED = 1_000_000
# The most messages Discord answers a page.
PAGE = 100
# Discord's own bodies for the refusals a test arms. A 429 is retried after
# its retry_after, so it waits none.
REFUSALS: dict[int, dict[str, Any]] = {
    401: {"message": "401: Unauthorized", "code": 0},
    403: {"message": "Missing Access", "code": 50001},
    404: {"message": "Unknown Channel", "code": 10003},
    429: {
        "message": "You are being rate limited.",
        "retry_after": 0,
        "global": False,
    },
    500: {"message": "500: Internal Server Error", "code": 0},
}


def day_of(snowflake: int) -> date:
    """The UTC day a snowflake was minted on.

    Args:
        snowflake (int): the snowflake.
    """
    ms = (snowflake >> 22) + DISCORD_EPOCH
    return datetime.fromtimestamp(ms / 1000, timezone.utc).date()


class DiscordGuild:
    """One Discord server on the integ Discord fake, in the world the unit
    fixture seeds, as the bot reaches it, and the reads a test checks it
    by.

    The world (integ/fixtures/discord/unit.json): My Server (111) with
    general (211) and random (212); members alice (311, nick al), bob (312)
    and the bot (911); general holds hello and files on 2024-01-15, the
    second carrying kept.txt and a tombstoned attachment, and morning on
    01-16; random holds one message on 01-14.

    Args:
        origin (str): the Discord fake's origin.
    """

    def __init__(self, origin: str) -> None:
        self.run = KitRun(origin, {"Authorization": f"Bot {TOKEN}"})

    async def reset(self, fixture: str = FIXTURE) -> None:
        """Seed the run afresh with a fixture's world and record its
        requests.

        Args:
            fixture (str): the fixture under integ/fixtures/discord/.
        """
        await self.run.call("POST", "/reset", json={"fixture": fixture})
        await self.run.record_requests()

    def fields(self, **overrides: Any) -> dict[str, Any]:
        """A mount config's fields on the guild, as the bot.

        Args:
            **overrides (Any): config fields to set or replace.
        """
        return {"token": TOKEN, "base_url": f"{self.run.url}/api/v10"} | (
            overrides
        )

    def config(self, **overrides: Any) -> DiscordConfig:
        """A mount config on the guild.

        Args:
            **overrides (Any): config fields to set or replace.
        """
        return DiscordConfig(**self.fields(**overrides))

    def accessor(
        self, time_range: TimeRange = TimeRange(), **overrides: Any
    ) -> DiscordAccessor:
        """A Mirage accessor on the guild.

        Args:
            time_range (TimeRange): the mount's time scope.
            **overrides (Any): config fields to set or replace.
        """
        return DiscordAccessor(self.config(**overrides), time_range)

    async def day(self, channel: str, day: str) -> list[dict[str, Any]]:
        """A channel's messages of one UTC day, oldest first, as Discord
        answers them.

        Args:
            channel (str): the channel's id.
            day (str): the day, ``YYYY-MM-DD``.
        """
        start = datetime.fromisoformat(day).replace(tzinfo=timezone.utc)
        after = snowflake_at(start.timestamp()) - 1
        end = snowflake_at(start.timestamp() + 86_400)
        kept: list[dict[str, Any]] = []
        while after < end:
            page = await self.run.call(
                "GET",
                f"/api/v10/channels/{channel}/messages",
                params={"after": str(after), "limit": str(PAGE)},
            )
            kept += [m for m in page if int(m["id"]) < end]
            if len(page) < PAGE:
                break
            after = max(int(m["id"]) for m in page)
        return sorted(kept, key=lambda m: int(m["id"]))

    async def channel(self, channel: str) -> dict[str, Any]:
        """A channel of the guild, as Discord lists it.

        Args:
            channel (str): the channel's id.
        """
        channels = await self.run.call(
            "GET", f"/api/v10/guilds/{GUILD}/channels"
        )
        return next(c for c in channels if c["id"] == channel)

    async def add_messages(
        self, channel: str, author: str, posts: list[tuple[datetime, str]]
    ) -> None:
        """Store messages another client posted, each at its time. Discord
        mints a post's time itself, so a message on a past day is a stored
        state, all of them in one statement: the run reloads, which
        restarts the recording.

        Args:
            channel (str): the channel's id.
            author (str): the member's user id.
            posts (list[tuple[datetime, str]]): each post's UTC time and
                text.
        """
        user = json.dumps((await self.member(author))["user"])
        rows = []
        params: list[Any] = []
        for seq, (at, content) in enumerate(posts, start=900):
            snowflake = snowflake_at(at.timestamp())
            rows.append("('default', ?, ?, ?, ?, ?, ?, ?, ?, '[]')")
            params += [
                str(snowflake),
                seq,
                snowflake,
                channel,
                GUILD,
                content,
                at.strftime("%Y-%m-%dT%H:%M:%S.000000+00:00"),
                user,
            ]
        await self.run.execute(
            "INSERT INTO DiscordMessage (tenant, id, seq, idNum, channelId, "
            "guildId, content, timestamp, authorJson, attachmentsJson) "
            f"VALUES {', '.join(rows)}",
            *params,
        )
        await self.run.record_requests()

    async def add_message(
        self, channel: str, at: datetime, author: str, content: str
    ) -> dict[str, Any]:
        """Store one message another client posted at ``at``, and the
        message as Discord answers it (see :meth:`add_messages`).

        Args:
            channel (str): the channel's id.
            at (datetime): when it was posted, in UTC.
            author (str): the member's user id.
            content (str): its text.
        """
        await self.add_messages(channel, author, [(at, content)])
        snowflake = str(snowflake_at(at.timestamp()))
        day = at.date().isoformat()
        return next(
            m for m in await self.day(channel, day) if m["id"] == snowflake
        )

    async def post(self, channel: str, content: str) -> dict[str, Any]:
        """Post a message as the bot, from another client.

        Args:
            channel (str): the channel's id.
            content (str): its text.
        """
        return await self.run.call(
            "POST",
            f"/api/v10/channels/{channel}/messages",
            json={"content": content},
        )

    async def message(self, channel: str, message: str) -> dict[str, Any]:
        """One message, as Discord answers it.

        Args:
            channel (str): the channel's id.
            message (str): the message's id.
        """
        return await self.run.call(
            "GET", f"/api/v10/channels/{channel}/messages/{message}"
        )

    async def member(self, user: str) -> dict[str, Any]:
        """A member of the guild, as Discord answers one.

        Args:
            user (str): the member's user id.
        """
        members = await self.run.call(
            "GET", f"/api/v10/guilds/{GUILD}/members", params={"limit": "1000"}
        )
        return next(m for m in members if m["user"]["id"] == user)

    async def day_fetches(self) -> list[tuple[str, str]]:
        """Each channel day fetched since recording started, as
        ``(channel, YYYY-MM-DD)``: a messages request whose ``after`` is
        the eve of a day, the first page of that day's walk."""
        listed = await self.run.call("GET", "/_kit/requests")
        fetched = []
        for r in listed["requests"]:
            if r["method"] != "GET" or r["route"] != MESSAGES:
                continue
            params = dict(parse_qsl(r["query"], keep_blank_values=True))
            if "after" not in params:
                continue
            first = int(params["after"]) + 1
            midnight = ((first >> 22) + DISCORD_EPOCH) % 86_400_000 == 0
            if midnight:
                channel = r["path"].split("/")[4]
                fetched.append((channel, day_of(first).isoformat()))
        return fetched

    async def count(self, route: str, method: str = "GET") -> int:
        """How many requests went to ``route`` since recording started.

        Args:
            route (str): the route as the fake declares it.
            method (str): the HTTP method.
        """
        listed = await self.run.call("GET", "/_kit/requests")
        return sum(
            1
            for r in listed["requests"]
            if r["route"] == route and r["method"] == method
        )

    async def refuse(
        self, route: str, status: int, times: int = UNTIL_CLEARED
    ) -> None:
        """Answer requests to ``route`` with Discord's ``status``.

        Args:
            route (str): the route as the fake declares it.
            status (int): the HTTP status.
            times (int): how many requests it answers.
        """
        await self.run.answer_next(
            "GET", route, status, REFUSALS[status], times=times
        )

    async def close(self) -> None:
        """Drop the run."""
        await self.run.close()


@pytest_asyncio.fixture
async def discord_guild(discord_origin: str) -> AsyncIterator[DiscordGuild]:
    """A Discord server of the test's own, seeded with the unit world."""
    guild = DiscordGuild(discord_origin)
    await guild.reset()
    yield guild
    await guild.close()
