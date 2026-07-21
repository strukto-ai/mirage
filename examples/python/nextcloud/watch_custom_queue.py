import asyncio
import os
from functools import partial

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.resource.nextcloud import NextcloudConfig, NextcloudResource
from mirage.types import PathSpec
from mirage.watch import DeltaHook, RAMWatchQueue, Watcher

load_dotenv(".env.development")

MOUNT = "/nc"
FOLDER = "custom-queue-demo"

config = NextcloudConfig(
    url=os.environ["NEXTCLOUD_URL"],
    username=os.environ.get("NEXTCLOUD_USERNAME", "admin"),
    password=os.environ.get("NEXTCLOUD_PASSWORD", "admin123"),
)
ws = Workspace({MOUNT: NextcloudResource(config)}, mode=MountMode.WRITE)
# A separate accessor plays the "external writer": a teammate, a cron
# job, anything mutating Nextcloud behind the workspace's back.
external = NextcloudAccessor(config).operator()

# The customization hook: attach the runtime yourself instead of
# letting the first watch() build the default one. Here every watch
# gets a tiny RAM queue (3 pending paths) so a burst overflows and
# collapses into one UNKNOWN "re-inventory" event.
ws.attach_watch_runtime(
    Watcher(ws.registry, queue_factory=partial(RAMWatchQueue, max_pending=3)))


class ConsumerPoller:
    """The consumer-owned pull loop: diff the backend, feed notify."""

    def __init__(self, hook: DeltaHook, root: PathSpec) -> None:
        self._hook = hook
        self._root = root
        self._checkpoint: str | None = None

    async def pump(self) -> None:
        delta = await self._hook.pull(self._root, self._checkpoint)
        self._checkpoint = delta.checkpoint
        for change in delta.changes:
            await ws.notify(change)


async def main() -> None:
    root = PathSpec.from_str_path(f"{MOUNT}/{FOLDER}", resource_path=FOLDER)
    poller = ConsumerPoller(
        ws.registry.mount_for(MOUNT).resource.delta_hook(), root)
    await external.create_dir(FOLDER + "/")
    await poller.pump()  # baseline: emits nothing

    agen = ws.watch(f"{MOUNT}/{FOLDER}")
    first = asyncio.ensure_future(agen.__anext__())
    await asyncio.sleep(0.05)

    print("one external change -> one event:")
    await external.write(f"{FOLDER}/report.txt", b"quarterly numbers")
    await poller.pump()
    event = await first
    print(f"  {event.kind.value} {event.path.virtual}")

    print("burst of 5 while the consumer is busy -> queue (cap 3)"
          " collapses:")
    for i in range(5):
        await external.write(f"{FOLDER}/bulk-{i}.txt", b"row")
    await poller.pump()
    event = await agen.__anext__()
    print(f"  {event.kind.value} {event.path.virtual}"
          "  (precision degraded, dirtiness kept)")

    result = await ws.execute(f"ls {MOUNT}/{FOLDER}")
    listing = (await result.stdout_str()).split()
    print(f"  re-inventory: {len(listing)} entries, guaranteed fresh")

    await agen.aclose()
    await ws.detach_watch_runtime()  # closes every subscriber queue
    await ws.close()


if __name__ == "__main__":
    asyncio.run(main())
