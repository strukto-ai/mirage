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
import os

from aiohttp import web
from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.core.slack.watch import SlackEventHook
from mirage.types import PathSpec
from mirage.vfs.slack import SlackConfig, SlackVFS

load_dotenv(".env.development")

MOUNT = "/slack"
ROOT = PathSpec(virtual=MOUNT, directory=MOUNT, vfs_path="")

config = SlackConfig(token=os.environ["SLACK_BOT_TOKEN"])
vfs = SlackVFS(config=config)
ws = Workspace({MOUNT: vfs}, mode=MountMode.READ)
hook = SlackEventHook(vfs.accessor)


async def handle(request: web.Request) -> web.Response:
    """Receive one Slack Events API delivery and refresh the mount.

    Mirage hosts no server and opens no socket, so this endpoint is
    yours: Slack posts here, you unwrap the envelope, and the hook turns
    the event into the paths it changed. Everything after ``notify`` is
    mirage's: the stale listings are evicted and any live ``watch``
    stream is woken.

    Args:
        request (web.Request): The POST Slack sent.
    """
    body = await request.json()
    if body.get("type") == "url_verification":
        return web.json_response({"challenge": body["challenge"]})
    event = body.get("event") or {}
    for change in await hook.to_events(ROOT, event.get("type", ""), event):
        print(f"  {change.kind.value:7} {change.path.virtual}")
        await ws.notify(change)
    return web.Response(text="ok")


async def watcher() -> None:
    """Print every change delivered to a subscriber of the mount."""
    async for change in ws.watch(f"{MOUNT}/channels"):
        print(f"watch -> {change.kind.value} {change.path.virtual}")


async def main() -> None:
    app = web.Application()
    app.router.add_post("/slack/events", handle)
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", 3000).start()

    print("POST http://localhost:3000/slack/events")
    print("Point your Slack app's Event Subscriptions here and subscribe to")
    print("message.channels, reaction_added, file_shared, channel_rename.\n")
    print("A message maps to that day's transcript, bucketed in UTC:")
    print("  /slack/channels/<name>__<CID>/<YYYY-MM-DD>/chat.jsonl")
    print("A thread reply maps to the PARENT's day, because chat.jsonl")
    print("renders conversations.history and a reply is in no day file.\n")

    task = asyncio.ensure_future(watcher())
    try:
        await asyncio.Event().wait()
    finally:
        task.cancel()
        await runner.cleanup()
        await ws.close()


if __name__ == "__main__":
    asyncio.run(main())
