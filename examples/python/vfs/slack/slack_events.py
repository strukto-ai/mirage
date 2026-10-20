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
import hashlib
import hmac
import json
import os
import time

from aiohttp import web
from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.core.slack.events import SlackEventHook
from mirage.types import PathSpec
from mirage.vfs.slack import SlackConfig, SlackVFS

load_dotenv(".env.development")

MOUNT = "/slack"
ROOT = PathSpec(virtual=MOUNT, directory=MOUNT, vfs_path="")
MAX_AGE = 5 * 60


def required_env(name: str) -> str:
    """An environment variable that must be set and non-empty.

    Args:
        name (str): The variable's name.
    """
    value = os.environ.get(name, "")
    if not value:
        raise RuntimeError(f"{name} env var is required")
    return value


config = SlackConfig(token=required_env("SLACK_BOT_TOKEN"))
signing_secret = required_env("SLACK_SIGNING_SECRET").encode()
vfs = SlackVFS(config=config)
ws = Workspace({MOUNT: vfs}, mode=MountMode.READ)
hook = SlackEventHook(vfs.accessor)


def header(request: web.Request, name: str) -> bytes:
    """A header's raw bytes when it was sent exactly once, else empty.

    Args:
        request (web.Request): The delivery.
        name (str): The header's name.
    """
    values = request.headers.getall(name, [])
    if len(values) != 1:
        return b""
    return values[0].encode(errors="surrogateescape")


def signed(request: web.Request, body: bytes) -> bool:
    """Whether a delivery carries a valid, fresh Slack signature.

    Slack signs ``v0:<timestamp>:<raw body>`` with the app's signing
    secret (HMAC-SHA256) and sends ``v0=<hex>`` as ``X-Slack-Signature``.
    A timestamp more than five minutes from now is refused as a replay.

    Args:
        request (web.Request): The delivery, read for its headers.
        body (bytes): The raw body, exactly as it arrived.
    """
    timestamp = header(request, "X-Slack-Request-Timestamp")
    if not timestamp.isdigit():
        return False
    if abs(time.time() - float(timestamp)) > MAX_AGE:
        return False
    base = b"v0:" + timestamp + b":" + body
    digest = hmac.new(signing_secret, base, hashlib.sha256).hexdigest()
    expected = f"v0={digest}".encode()
    return hmac.compare_digest(header(request, "X-Slack-Signature"), expected)


async def handle(request: web.Request) -> web.Response:
    """Receive one Slack Events API delivery and refresh the mount.

    Mirage hosts no server and opens no socket, so this endpoint is
    yours: Slack posts here, you check its signature over the raw body
    before anything else, unwrap the envelope, and the hook turns the
    event into the paths it changed. Everything after ``notify`` is
    mirage's: the stale listings are evicted and any live ``events``
    stream is woken.

    Args:
        request (web.Request): The POST Slack sent.
    """
    raw = await request.read()
    if not signed(request, raw):
        return web.Response(status=401, text="invalid signature")
    body = json.loads(raw)
    if body.get("type") == "url_verification":
        return web.json_response({"challenge": body["challenge"]})
    event = body.get("event") or {}
    for change in await hook.to_events(ROOT, event.get("type", ""), event):
        print(f"  {change.kind.value:7} {change.path.virtual}")
        await ws.notify(change)
    return web.Response(text="ok")


async def subscriber() -> None:
    """Print every change delivered to a subscriber of the mount."""
    async for change in ws.events(f"{MOUNT}/channels"):
        print(f"event -> {change.kind.value} {change.path.virtual}")


async def main() -> None:
    app = web.Application()
    app.router.add_post("/slack/events", handle)
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", 3000).start()

    print("POST http://127.0.0.1:3000/slack/events")
    print("Expose it through a tunnel, point your Slack app's Event")
    print("Subscriptions at the tunnel and subscribe to")
    print("message.channels, reaction_added, file_shared, channel_rename.\n")
    print("A message maps to that day's transcript, bucketed in UTC:")
    print("  /slack/channels/<name>__<CID>/<YYYY-MM-DD>/chat.jsonl")
    print("A thread reply maps to the PARENT's day, because chat.jsonl")
    print("renders conversations.history and a reply is in no day file.\n")

    task = asyncio.ensure_future(subscriber())
    try:
        await asyncio.Event().wait()
    finally:
        task.cancel()
        await runner.cleanup()
        await ws.close()


if __name__ == "__main__":
    asyncio.run(main())
