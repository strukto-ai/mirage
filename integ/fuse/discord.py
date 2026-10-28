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
import errno
import json
from pathlib import Path

from aiohttp import web
from aiohttp.test_utils import TestServer

from mirage import Workspace
from mirage.core.api.errors import ApiError
from mirage.fuse.fs import MirageFS
from mirage.mount.core import MountCore
from mirage.mount.errors import classify_error
from mirage.policy import Deny, Policy
from mirage.types import MountMode
from mirage.vfs.discord import DiscordConfig, DiscordVFS

CORPUS = json.loads(Path(__file__).with_name("discord_cases.json").read_text())
FILE = CORPUS["file"]
BODY = CORPUS["body"].encode()


class DiscordHTTP:
    def __init__(self):
        self.status = 403
        self.requests = []
        self.statuses = []

    async def request(self, request):
        assert request.method == "GET"
        assert request.headers["Authorization"] == "Bot test-token"
        self.requests.append(request.path)
        if request.path == "/users/@me/guilds":
            return web.json_response([CORPUS["guild"]])
        if request.path == "/guilds/G1/channels":
            return web.json_response([CORPUS["channel"]])
        assert request.path == "/channels/C1/messages"
        assert request.query["limit"] == "100"
        assert "after" in request.query
        self.statuses.append(self.status)
        body = (
            list(reversed(CORPUS["messages"]))
            if self.status == 200
            else {"message": "refused", "retry_after": 0}
        )
        return web.json_response(body, status=self.status)


class ReadPolicy(Policy):
    def __init__(self):
        self.stage = None
        self.seen = []

    async def pre_vfs(self, ctx):
        if ctx.call.name == "read" and self.stage == "pre_vfs":
            self.seen.append("pre_vfs")
            return Deny("sealed")
        return None

    async def post_vfs(self, ctx):
        if ctx.call.name == "read" and self.stage == "post_vfs":
            assert ctx.result == BODY
            self.seen.append("post_vfs")
            return Deny("sealed")
        return None


class Driver:
    def __init__(self, ws, backend, adapter):
        self.ws, self.backend = ws, backend
        session = ws.create_session("reader")
        self.fuse = (
            MirageFS(ws.vfs, session=session) if adapter == "fuse" else None
        )
        self.core = (
            self.fuse.core
            if self.fuse is not None
            else MountCore(ws.vfs, session=session)
        )
        self.opened = set()

    async def size(self, fh=None):
        if self.fuse is not None:
            return (await asyncio.to_thread(self.fuse.getattr, FILE, fh))[
                "st_size"
            ]
        return (await self.core.fgetattr(FILE, fh)).size

    async def open(self):
        fh = (
            await asyncio.to_thread(self.fuse.open, FILE, 0)
            if self.fuse is not None
            else await self.core.open(FILE)
        )
        self.opened.add(fh)
        return fh

    async def read(self, fh, offset=0, size=None):
        size = len(BODY) + 10 if size is None else size
        if self.fuse is not None:
            return await asyncio.to_thread(
                self.fuse.read, FILE, size, offset, fh
            )
        return await self.core.read(FILE, size, offset, fh)

    async def release(self, fh):
        if self.fuse is not None:
            await asyncio.to_thread(self.fuse.release, FILE, fh)
        else:
            await self.core.release(fh)
        self.opened.discard(fh)
        assert fh not in self.core.handles

    async def close(self):
        try:
            for fh in list(self.opened):
                await self.release(fh)
        finally:
            session = self.backend.accessor.pool._session
            try:
                if self.fuse is not None:
                    await asyncio.wrap_future(
                        asyncio.run_coroutine_threadsafe(
                            self.backend.accessor.close(), self.fuse._loop
                        )
                    )
                await self.ws.close()
                assert session is None or session.closed
                assert not self.opened
            finally:
                if self.fuse is not None:
                    loop = self.fuse._loop
                    loop.call_soon_threadsafe(loop.stop)
                    while loop.is_running():
                        await asyncio.sleep(0)
                    loop.close()


async def refused(pending, code):
    try:
        await pending
    except Exception as error:
        assert classify_error(error) == code, repr(error)
        return error
    raise AssertionError("read unexpectedly succeeded")


async def run(case):
    http, policy = DiscordHTTP(), ReadPolicy()
    app = web.Application()
    app.router.add_get("/{path:.*}", http.request)
    async with TestServer(app) as server:
        backend = DiscordVFS(
            config=DiscordConfig(
                token="test-token", base_url=str(server.make_url(""))
            )
        )
        ws = Workspace(
            {"/discord/": backend}, mode=MountMode.READ, policies=[policy]
        )
        driver = Driver(ws, backend, case["adapter"])
        try:
            assert (await ws.vfs.stat(FILE)).size is None
            assert await driver.size() == 0
            assert http.statuses == [403]
            http.status = case.get("status", 200)
            fh = await driver.open()
            if case["kind"] == "failure":
                error = await refused(driver.read(fh), case["expected_errno"])
                if driver.fuse is not None:
                    assert (
                        isinstance(error, OSError) and error.errno == errno.EIO
                    )
                    error = error.__cause__
                if case["status"] == 429:
                    assert isinstance(error, RuntimeError)
                    assert str(error) == "Rate limited after 3 retries"
                else:
                    assert isinstance(error, ApiError)
                    assert error.status == case["status"]
                if case["recover"]:
                    http.status = 200
                    assert await driver.read(fh) == BODY
                    assert await driver.size(fh) == len(BODY)
            else:
                assert await driver.size(fh) == len(BODY)
                if case["kind"] == "hydrate":
                    partial = CORPUS["partial"]
                    offset, size = partial["offset"], partial["size"]
                    assert (
                        await driver.read(fh, offset, size)
                        == BODY[offset : offset + size]
                    )
                    if not case["early_close"]:
                        assert await driver.read(fh) == BODY
                        assert await driver.read(fh, len(BODY), 9) == b""
                else:
                    assert await driver.read(fh) == BODY
                    before = len(http.requests)
                    restriction = case["restriction"]
                    if restriction == "hide":
                        await ws.set_session_profile(
                            "reader", {"paths": {"hide": [FILE]}}
                        )
                    elif restriction == "deny":
                        await ws.set_session_profile(
                            "reader",
                            {
                                "commands": {
                                    "deny": [
                                        {"paths": [FILE], "reason": "sealed"}
                                    ]
                                }
                            },
                        )
                    else:
                        policy.stage = restriction
                    await refused(driver.read(fh), case["expected_errno"])
                    if restriction == "hide":
                        await refused(driver.size(fh), errno.ENOENT)
                    if restriction in ("pre_vfs", "post_vfs"):
                        assert policy.seen == [restriction]
                    assert len(http.requests) == before
                    policy.stage = None
                    await ws.set_session_profile("reader", {})
                    assert await driver.read(fh) == BODY
                    assert len(http.requests) == before
            before = len(http.requests)
            await driver.release(fh)
            assert len(http.requests) == before
            assert http.statuses == case["expected_statuses"]
        finally:
            await driver.close()


async def main():
    for case in CORPUS["cases"]:
        try:
            await run(case)
        except Exception as error:
            raise AssertionError(case["id"]) from error
        print(json.dumps({"id": case["id"], "ok": True}), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
