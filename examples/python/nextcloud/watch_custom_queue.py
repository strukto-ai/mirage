import asyncio
import os
from functools import partial

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.core.nextcloud.watch import NextcloudEventHook
from mirage.types import PathSpec
from mirage.vfs.nextcloud import NextcloudConfig, NextcloudVFS
from mirage.watch import RAMWatchQueue, Watcher

load_dotenv(".env.development")

MOUNT = "/nc"
FOLDER = "custom-queue-demo"

config = NextcloudConfig(
    url=os.environ["NEXTCLOUD_URL"],
    username=os.environ.get("NEXTCLOUD_USERNAME", "admin"),
    password=os.environ.get("NEXTCLOUD_PASSWORD", "admin123"),
)
vfs = NextcloudVFS(config)
ws = Workspace({MOUNT: vfs}, mode=MountMode.WRITE)
# A separate accessor plays the "external writer": a teammate, a cron
# job, anything mutating Nextcloud behind the workspace's back.
external = NextcloudAccessor(config).operator()

# The customization hook: attach the runtime yourself instead of
# letting the first watch() build the default one. Here every watch
# gets a tiny RAM queue (3 pending paths) so a burst overflows and
# collapses into one UNKNOWN "re-inventory" event.
ws.attach_watch_runtime(
    Watcher(ws.registry, queue_factory=partial(RAMWatchQueue, max_pending=3))
)


CREATED = "OCP\\Files\\Events\\Node\\NodeCreatedEvent"


class Receiver:
    """Stands in for the consumer's webhook route: each delivery
    Nextcloud would POST is mapped by ``NextcloudEventHook`` and fed to
    notify."""

    def __init__(self) -> None:
        self._hook = NextcloudEventHook(vfs.accessor)
        self._root = PathSpec.from_str_path(MOUNT, vfs_path="")

    async def created(self, rel: str) -> None:
        payload = {
            "event": {
                "class": CREATED,
                "node": {"path": f"/{config.username}/files/{rel}"},
            }
        }
        for change in await self._hook.to_events(self._root, CREATED, payload):
            await ws.notify(change)


async def main() -> None:
    receiver = Receiver()
    await external.create_dir(FOLDER + "/")

    agen = ws.watch(f"{MOUNT}/{FOLDER}")
    first = asyncio.ensure_future(agen.__anext__())
    await asyncio.sleep(0.05)

    print("one external change -> one event:")
    await external.write(f"{FOLDER}/report.txt", b"quarterly numbers")
    await receiver.created(f"{FOLDER}/report.txt")
    event = await first
    print(f"  {event.kind.value} {event.path.virtual}")

    print("burst of 5 while the consumer is busy -> queue (cap 3) collapses:")
    for i in range(5):
        await external.write(f"{FOLDER}/bulk-{i}.txt", b"row")
        await receiver.created(f"{FOLDER}/bulk-{i}.txt")
    event = await agen.__anext__()
    print(
        f"  {event.kind.value} {event.path.virtual}"
        "  (precision degraded, dirtiness kept)"
    )

    result = await ws.shell(f"ls {MOUNT}/{FOLDER}")
    listing = (await result.stdout_str()).split()
    print(f"  re-inventory: {len(listing)} entries, guaranteed fresh")

    await agen.aclose()
    await ws.detach_watch_runtime()  # closes every subscriber queue
    await ws.close()


if __name__ == "__main__":
    asyncio.run(main())
