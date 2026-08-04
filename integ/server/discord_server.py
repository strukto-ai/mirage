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

import argparse
import asyncio
import json
from pathlib import Path
from typing import Any

from aiohttp import web

FIXTURE = Path(
    __file__).resolve().parents[1] / "fixtures" / "discord" / "v1.json"

DISCORD_EPOCH = 1420070400000
# 2026-06-03T00:00:00Z, one day past the newest fixture message, so the 30
# date directories a channel lists are a fixed window.
POST_SNOWFLAKE_BASE = 1511553600000
MESSAGES_MAX_LIMIT = 100
MEMBERS_MAX_LIMIT = 1000


def snowflake_at(ms: int) -> str:
    return str((ms - DISCORD_EPOCH) << 22)


class FakeDiscord:
    """In-memory Discord API state seeded from the fixture.

    Mirrors the documented shapes: guild/channel/member/message objects,
    `after`+`limit` pagination, and newest-first message ordering.
    """

    def __init__(self) -> None:
        self.base = ""
        self.bot_user: dict[str, Any] = {}
        self.guilds: list[dict[str, Any]] = []
        self.guild_channels: dict[str, list[dict[str, Any]]] = {}
        self.guild_members: dict[str, list[dict[str, Any]]] = {}
        self.channel_messages: dict[str, list[dict[str, Any]]] = {}
        self.channel_guild: dict[str, str] = {}
        self.attachments: dict[str, bytes] = {}
        self.reactions: list[dict[str, str]] = []
        self._post_seq = 0

    def seed(self, data: dict[str, Any]) -> None:
        self.bot_user = dict(data.get("bot_user", {}))
        self.guilds = []
        self.guild_channels = {}
        self.guild_members = {}
        self.channel_messages = {}
        self.channel_guild = {}
        self.attachments = {}
        self.reactions = []
        self._post_seq = 0
        for guild in data.get("guilds", []):
            self._seed_guild(guild)

    def _seed_guild(self, guild: dict[str, Any]) -> None:
        gid = guild["id"]
        self.guilds.append({
            "id": gid,
            "name": guild.get("name", ""),
            "owner": False,
            "permissions": "0",
            "features": [],
        })
        self.guild_members[gid] = [
            dict(member) for member in guild.get("members", [])
        ]
        channels: list[dict[str, Any]] = []
        for channel in guild.get("channels", []):
            cid = channel["id"]
            self.channel_guild[cid] = gid
            messages = [
                self._seed_message(cid, raw)
                for raw in guild.get("messages", {}).get(cid, [])
            ]
            messages.sort(key=lambda m: int(m["id"]))
            self.channel_messages[cid] = messages
            channels.append({
                "id":
                cid,
                "type":
                channel.get("type", 0),
                "guild_id":
                gid,
                "name":
                channel.get("name", ""),
                "position":
                channel.get("position", 0),
                "topic":
                channel.get("topic"),
                "parent_id":
                None,
                "last_message_id":
                messages[-1]["id"] if messages else None,
            })
        self.guild_channels[gid] = channels

    def _seed_message(self, channel_id: str, raw: dict[str,
                                                       Any]) -> dict[str, Any]:
        author_id = raw["author"]
        author = self._user(author_id)
        attachments = []
        for att in raw.get("attachments", []):
            body = att.get("body", "").encode()
            self.attachments[att["id"]] = body
            attachments.append({
                "id":
                att["id"],
                "filename":
                att["filename"],
                "size":
                len(body),
                "url":
                f"{{base}}/attachments/{att['id']}/{att['filename']}",
                "proxy_url":
                f"{{base}}/attachments/{att['id']}/{att['filename']}",
                "content_type":
                att.get("content_type", "application/octet-stream"),
            })
        return {
            "id": raw["id"],
            "channel_id": channel_id,
            "author": author,
            "content": raw.get("content", ""),
            "timestamp": raw["timestamp"],
            "edited_timestamp": None,
            "tts": False,
            "pinned": False,
            "mention_everyone": False,
            "mentions": [],
            "mention_roles": [],
            "attachments": attachments,
            "embeds": [],
            "type": 0,
        }

    def _user(self, user_id: str) -> dict[str, Any]:
        for members in self.guild_members.values():
            for member in members:
                if member.get("user", {}).get("id") == user_id:
                    return dict(member["user"])
        return {"id": user_id, "username": "unknown", "bot": False}

    def resolve(self, value: Any) -> Any:
        """Substitute the live origin into fixture-authored CDN URLs.

        Args:
            value: any JSON value from the seeded state.
        """
        if isinstance(value, str):
            return value.replace("{base}", self.base)
        if isinstance(value, list):
            return [self.resolve(item) for item in value]
        if isinstance(value, dict):
            return {k: self.resolve(v) for k, v in value.items()}
        return value

    def next_post(self, channel_id: str, content: str) -> dict[str, Any]:
        self._post_seq += 1
        message = {
            "id": snowflake_at(POST_SNOWFLAKE_BASE + self._post_seq * 1000),
            "channel_id": channel_id,
            "author": dict(self.bot_user) | {
                "bot": True
            },
            "content": content,
            "timestamp": "2026-06-03T00:00:00.000000+00:00",
            "edited_timestamp": None,
            "tts": False,
            "pinned": False,
            "mention_everyone": False,
            "mentions": [],
            "mention_roles": [],
            "attachments": [],
            "embeds": [],
            "type": 0,
        }
        self.channel_messages.setdefault(channel_id, []).append(message)
        return message

    def next_thread(self, channel_id: str, name: str,
                    message_id: str | None) -> dict[str, Any]:
        self._post_seq += 1
        thread = {
            "id": snowflake_at(POST_SNOWFLAKE_BASE + self._post_seq * 1000),
            "type": 11,
            "guild_id": self.channel_guild.get(channel_id, ""),
            "parent_id": channel_id,
            "owner_id": self.bot_user.get("id", ""),
            "name": name,
            "message_count": 0,
            "member_count": 1,
        }
        if message_id is not None:
            thread["last_message_id"] = message_id
        return thread


def unauthorized() -> web.Response:
    return web.json_response({
        "message": "401: Unauthorized",
        "code": 0
    },
                             status=401)


def not_found() -> web.Response:
    return web.json_response({
        "message": "Unknown Channel",
        "code": 10003
    },
                             status=404)


def clamp(raw: str | None, default: int, maximum: int) -> int:
    try:
        value = int(raw) if raw is not None else default
    except ValueError:
        return default
    return max(1, min(value, maximum))


class DiscordServer:

    def __init__(self, state: FakeDiscord) -> None:
        self.state = state

    def _authed(self, request: web.Request) -> bool:
        return request.headers.get("Authorization", "").startswith("Bot ")

    async def reset(self, request: web.Request) -> web.Response:
        self.state.seed(json.loads(FIXTURE.read_text()))
        return web.json_response({"ok": True})

    async def current_user_guilds(self, request: web.Request) -> web.Response:
        if not self._authed(request):
            return unauthorized()
        after = request.query.get("after", "0")
        limit = clamp(request.query.get("limit"), 200, 200)
        rows = [g for g in self.state.guilds if int(g["id"]) > int(after)]
        rows.sort(key=lambda g: int(g["id"]))
        return web.json_response(rows[:limit])

    async def guild_channels(self, request: web.Request) -> web.Response:
        if not self._authed(request):
            return unauthorized()
        gid = request.match_info["guild_id"]
        channels = self.state.guild_channels.get(gid)
        if channels is None:
            return not_found()
        # Documented as not paginated: the whole channel list comes back.
        return web.json_response(channels)

    async def guild_members(self, request: web.Request) -> web.Response:
        if not self._authed(request):
            return unauthorized()
        gid = request.match_info["guild_id"]
        members = self.state.guild_members.get(gid)
        if members is None:
            return not_found()
        after = request.query.get("after", "0")
        limit = clamp(request.query.get("limit"), 1, MEMBERS_MAX_LIMIT)
        rows = [
            m for m in members
            if int(m.get("user", {}).get("id", 0)) > int(after)
        ]
        # Documented as ordered by user id, ascending.
        rows.sort(key=lambda m: int(m["user"]["id"]))
        return web.json_response(rows[:limit])

    async def search_members(self, request: web.Request) -> web.Response:
        if not self._authed(request):
            return unauthorized()
        gid = request.match_info["guild_id"]
        members = self.state.guild_members.get(gid)
        if members is None:
            return not_found()
        query = request.query.get("query", "").lower()
        limit = clamp(request.query.get("limit"), 1, MEMBERS_MAX_LIMIT)
        # Documented as a prefix match on username or nickname.
        rows = [
            m for m in members
            if m.get("user", {}).get("username", "").lower().startswith(query)
            or (m.get("nick") or "").lower().startswith(query)
        ]
        rows.sort(key=lambda m: int(m["user"]["id"]))
        return web.json_response(rows[:limit])

    async def channel_messages(self, request: web.Request) -> web.Response:
        if not self._authed(request):
            return unauthorized()
        cid = request.match_info["channel_id"]
        messages = self.state.channel_messages.get(cid)
        if messages is None:
            return not_found()
        limit = clamp(request.query.get("limit"), 50, MESSAGES_MAX_LIMIT)
        after = request.query.get("after")
        before = request.query.get("before")
        rows = list(messages)
        if after is not None:
            # `after` walks forward: the window is the oldest ids above the
            # cursor, so the caller advances with the newest id it received.
            rows = [m for m in rows if int(m["id"]) > int(after)][:limit]
        elif before is not None:
            rows = [m for m in rows if int(m["id"]) < int(before)][-limit:]
        else:
            rows = rows[-limit:]
        # Documented order: newest to oldest, whichever cursor was used.
        rows.sort(key=lambda m: int(m["id"]), reverse=True)
        return web.json_response(self.state.resolve(rows))

    async def create_message(self, request: web.Request) -> web.Response:
        if not self._authed(request):
            return unauthorized()
        cid = request.match_info["channel_id"]
        if cid not in self.state.channel_messages:
            return not_found()
        body = await request.json()
        message = self.state.next_post(cid, str(body.get("content", "")))
        if isinstance(body.get("poll"), dict):
            # Discord echoes the poll object (with defaults resolved) on the
            # created message; the fake echoes it verbatim.
            message["poll"] = body["poll"]
        return web.json_response(message)

    async def edit_message(self, request: web.Request) -> web.Response:
        if not self._authed(request):
            return unauthorized()
        cid = request.match_info["channel_id"]
        mid = request.match_info["message_id"]
        body = await request.json()
        for message in self.state.channel_messages.get(cid, []):
            if message["id"] == mid:
                message["content"] = str(body.get("content", ""))
                message["edited_timestamp"] = (
                    "2026-06-03T00:05:00.000000+00:00")
                return web.json_response(message)
        return web.json_response({
            "message": "Unknown Message",
            "code": 10008
        },
                                 status=404)

    async def delete_message(self, request: web.Request) -> web.Response:
        if not self._authed(request):
            return unauthorized()
        cid = request.match_info["channel_id"]
        mid = request.match_info["message_id"]
        messages = self.state.channel_messages.get(cid, [])
        for message in messages:
            if message["id"] == mid:
                messages.remove(message)
                return web.Response(status=204)
        return web.json_response({
            "message": "Unknown Message",
            "code": 10008
        },
                                 status=404)

    async def create_thread(self, request: web.Request) -> web.Response:
        if not self._authed(request):
            return unauthorized()
        cid = request.match_info["channel_id"]
        if cid not in self.state.channel_messages:
            return not_found()
        mid = request.match_info.get("message_id")
        if mid is not None and not any(
                m["id"] == mid
                for m in self.state.channel_messages.get(cid, [])):
            return web.json_response(
                {
                    "message": "Unknown Message",
                    "code": 10008
                }, status=404)
        body = await request.json()
        if mid is None and body.get("type") not in (11, 12):
            return web.json_response(
                {
                    "message": "Invalid Form Body",
                    "code": 50035
                }, status=400)
        thread = self.state.next_thread(cid, str(body.get("name", "")), mid)
        return web.json_response(thread)

    async def guild_info(self, request: web.Request) -> web.Response:
        if not self._authed(request):
            return unauthorized()
        gid = request.match_info["guild_id"]
        for guild in self.state.guilds:
            if guild.get("id") == gid:
                return web.json_response(guild)
        return not_found()

    async def search_messages(self, request: web.Request) -> web.Response:
        if not self._authed(request):
            return unauthorized()
        gid = request.match_info["guild_id"]
        content = request.query.get("content", "")
        channel_filter = request.query.get("channel_id")
        contexts = []
        for channel in self.state.guild_channels.get(gid, []):
            cid = channel["id"]
            if channel_filter is not None and cid != channel_filter:
                continue
            for message in self.state.channel_messages.get(cid, []):
                if content and content not in message.get("content", ""):
                    continue
                contexts.append([self.state.resolve([message])[0]])
        return web.json_response({
            "total_results": len(contexts),
            "messages": contexts,
        })

    async def add_reaction(self, request: web.Request) -> web.Response:
        if not self._authed(request):
            return unauthorized()
        cid = request.match_info["channel_id"]
        mid = request.match_info["message_id"]
        if not any(m["id"] == mid
                   for m in self.state.channel_messages.get(cid, [])):
            return web.json_response(
                {
                    "message": "Unknown Message",
                    "code": 10008
                }, status=404)
        self.state.reactions.append({
            "channel_id": cid,
            "message_id": mid,
            "emoji": request.match_info["emoji"],
        })
        return web.Response(status=204)

    async def attachment(self, request: web.Request) -> web.Response:
        body = self.state.attachments.get(request.match_info["attachment_id"])
        if body is None:
            return web.Response(status=404)
        # The CDN serves attachments without the Authorization header.
        return web.Response(body=body, content_type="application/octet-stream")


def build_app(server: DiscordServer) -> web.Application:
    app = web.Application()
    app.router.add_post("/reset", server.reset)
    app.router.add_get("/api/v10/users/@me/guilds", server.current_user_guilds)
    app.router.add_get("/api/v10/guilds/{guild_id}/channels",
                       server.guild_channels)
    app.router.add_get("/api/v10/guilds/{guild_id}/members/search",
                       server.search_members)
    app.router.add_get("/api/v10/guilds/{guild_id}/members",
                       server.guild_members)
    app.router.add_get("/api/v10/channels/{channel_id}/messages",
                       server.channel_messages)
    app.router.add_post("/api/v10/channels/{channel_id}/messages",
                        server.create_message)
    app.router.add_patch(
        "/api/v10/channels/{channel_id}/messages/{message_id}",
        server.edit_message)
    app.router.add_delete(
        "/api/v10/channels/{channel_id}/messages/{message_id}",
        server.delete_message)
    app.router.add_post(
        "/api/v10/channels/{channel_id}/messages/{message_id}/threads",
        server.create_thread)
    app.router.add_post("/api/v10/channels/{channel_id}/threads",
                        server.create_thread)
    app.router.add_get("/api/v10/guilds/{guild_id}", server.guild_info)
    app.router.add_get("/api/v10/guilds/{guild_id}/messages/search",
                       server.search_messages)
    app.router.add_put(
        "/api/v10/channels/{channel_id}/messages/{message_id}"
        "/reactions/{emoji}/@me", server.add_reaction)
    app.router.add_get("/attachments/{attachment_id}/{filename}",
                       server.attachment)
    return app


async def start_fake_discord(
) -> tuple[FakeDiscord, DiscordServer, web.AppRunner]:
    state = FakeDiscord()
    state.seed(json.loads(FIXTURE.read_text()))
    server = DiscordServer(state)
    runner = web.AppRunner(build_app(server))
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    state.base = f"http://127.0.0.1:{port}"
    return state, server, runner


async def _serve(port: int) -> None:
    state = FakeDiscord()
    state.seed(json.loads(FIXTURE.read_text()))
    server = DiscordServer(state)
    runner = web.AppRunner(build_app(server))
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", port)
    await site.start()
    state.base = f"http://127.0.0.1:{port}"
    print(f"DISCORD_ENDPOINT={state.base}", flush=True)
    await asyncio.Event().wait()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    asyncio.run(_serve(args.port))


if __name__ == "__main__":
    main()
