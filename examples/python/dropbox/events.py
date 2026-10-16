import asyncio
import json
import os
from collections.abc import Awaitable, Callable
from functools import partial

import aiohttp

from mirage import Workspace
from mirage.events.base import DeltaHook
from mirage.types import FileEvent, PathSpec
from mirage.vfs.dropbox import DropboxConfig, DropboxVFS

MOUNT = "/dropbox"
LONGPOLL_URL = "https://notify.dropboxapi.com/2/files/list_folder/longpoll"
TIMEOUT = 30


def cursor_of(checkpoint: str | None) -> str | None:
    # This example knows where the Dropbox checkpoint keeps its cursor.
    # Hand the WHOLE checkpoint back to pull: it also holds the seen paths.
    data = json.loads(checkpoint) if checkpoint is not None else None
    state = data.get("dropbox") if isinstance(data, dict) else None
    if not isinstance(state, dict):
        raise ValueError("Expected a Dropbox checkpoint")
    return state.get("cursor") or None


async def longpoll(
    client: aiohttp.ClientSession, cursor: str
) -> tuple[bool, float]:
    # This endpoint takes NO Authorization header; the cursor is sufficient.
    async with client.post(
        LONGPOLL_URL, json={"cursor": cursor, "timeout": TIMEOUT}
    ) as response:
        if response.status == 409:
            failure = await response.json()
            if failure.get("error", {}).get(".tag") == "reset":
                # Pull with the OLD checkpoint: continue sees the reset and
                # reports the event root as unknown with a fresh cursor.
                return True, 0
        response.raise_for_status()
        result = await response.json()
        return result["changes"], result.get("backoff", 0)


async def run_longpoll(
    hook: DeltaHook,
    root: PathSpec,
    notify: Callable[[FileEvent], Awaitable[None]],
    poll: Callable[[str], Awaitable[tuple[bool, float]]],
    pause: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> None:
    checkpoint = (await hook.pull(root, None)).checkpoint
    while True:
        cursor = cursor_of(checkpoint)
        if cursor is None:
            await pause(TIMEOUT)
            changed, backoff = True, 0.0
        else:
            changed, backoff = await poll(cursor)
        if changed:
            delta = await hook.pull(root, checkpoint)
            for change in delta.changes:
                await notify(change)
            checkpoint = delta.checkpoint
        if backoff:
            await pause(backoff)


async def publish(ws: Workspace, change: FileEvent) -> None:
    await ws.notify(change)
    print(f"{change.kind.value}: {change.path.virtual}")


async def main() -> None:
    vfs = DropboxVFS(
        DropboxConfig(
            client_id=os.environ["DROPBOX_APP_KEY"],
            client_secret=os.environ["DROPBOX_APP_SECRET"],
            refresh_token=os.environ["DROPBOX_REFRESH_TOKEN"],
            root_path=os.environ.get("DROPBOX_ROOT_PATH") or "/",
        )
    )
    ws = Workspace({MOUNT: vfs})
    try:
        # Leave headroom for the server's jitter; never reuse an authenticated
        # API session for the notification host.
        async with aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=TIMEOUT + 100)
        ) as client:
            print(
                f"Listening on {MOUNT}; edit files in Dropbox (Ctrl-C to stop)"
            )
            await run_longpoll(
                vfs.delta_hook(),
                PathSpec.from_str_path(MOUNT, ""),
                partial(publish, ws),
                partial(longpoll, client),
            )
    finally:
        await ws.close()


if __name__ == "__main__":
    asyncio.run(main())
