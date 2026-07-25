import asyncio
import os
from datetime import datetime, timezone

from aiohttp import web
from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.resource.nextcloud import NextcloudConfig, NextcloudResource
from mirage.types import FileChangeKind, FileEvent, PathSpec

load_dotenv(".env.development")

MOUNT = "/nc"
PORT = int(os.environ.get("WEBHOOK_PORT", "8990"))

# Nextcloud webhook_listeners event class -> mirage change kind.
KIND_BY_CLASS = {
    "OCP\\Files\\Events\\Node\\NodeCreatedEvent": FileChangeKind.CREATE,
    "OCP\\Files\\Events\\Node\\NodeWrittenEvent": FileChangeKind.UPDATE,
    "OCP\\Files\\Events\\Node\\NodeDeletedEvent": FileChangeKind.DELETE,
}

config = NextcloudConfig(
    url=os.environ["NEXTCLOUD_URL"],
    username=os.environ.get("NEXTCLOUD_USERNAME", "admin"),
    password=os.environ.get("NEXTCLOUD_PASSWORD", "admin123"),
)
resource = NextcloudResource(config)
ws = Workspace({MOUNT: resource}, mode=MountMode.WRITE)
files_prefix = f"/{config.username}/files"


class WebhookReceiver:
    """The consumer-owned push endpoint: Nextcloud POSTs here.

    Mirage hosts no server; this receiver lives in your own service and
    just imports mirage. Each payload is mapped to a FileEvent and
    injected via ws.notify — no polling anywhere, no setup call: the
    watch runtime attaches lazily on first use.
    """

    def __init__(self, workspace: Workspace) -> None:
        self._ws = workspace

    def to_virtual(self, node_path: str) -> str:
        """Map Nextcloud's real path to the mirage virtual path.

        Nextcloud reports ``/<user>/files/<rel>`` (``node.path``); the
        mount is rooted at that same files directory, so stripping the
        prefix and prepending the mount yields the virtual path:
        ``/admin/files/data/report.txt`` -> ``/nc/data/report.txt``.

        Args:
            node_path (str): ``node.path`` from the webhook payload.
        """
        rel = node_path[len(files_prefix):] if node_path.startswith(
            files_prefix) else node_path
        return MOUNT + "/" + rel.strip("/")

    async def handle(self, request: web.Request) -> web.Response:
        payload = await request.json()
        event = payload.get("event", {})
        kind = KIND_BY_CLASS.get(event.get("class", ""))
        if kind is None:
            return web.json_response({"ok": True, "skipped": True})
        virtual = self.to_virtual(event.get("node", {}).get("path", ""))
        change = FileEvent(kind=kind,
                           path=PathSpec.from_str_path(virtual),
                           timestamp=datetime.fromtimestamp(int(
                               payload.get("time", 0)),
                                                            tz=timezone.utc))
        await self._ws.notify(change)
        print(f"webhook: {kind.value} {virtual}")
        return web.json_response({"ok": True})


def print_registration_help() -> None:
    """Print the one-time Nextcloud setup for push delivery."""
    callback = os.environ.get(
        "WEBHOOK_CALLBACK",
        f"http://host.docker.internal:{PORT}/nextcloud/webhook")
    base = config.url.split("/remote.php")[0]
    print("One-time Nextcloud setup (admin):")
    print("  1. Enable the app:  occ app:enable webhook_listeners")
    print("  2. Register one webhook per event class, e.g.:")
    for cls in KIND_BY_CLASS:
        escaped = cls.replace("\\", "\\\\")
        print(f'     curl -u {config.username}:*** -H "OCS-APIRequest: true"'
              f' -H "Content-Type: application/json"'
              f' -X POST {base}/ocs/v2.php/apps/webhook_listeners'
              f'/api/v1/webhooks/register'
              f' -d \'{{"httpMethod": "POST", "uri": "{callback}",'
              f' "event": "{escaped}"}}\'')
    print("  3. Delivery rides Nextcloud background jobs; with the docker"
          " image run `occ background:cron` (or enable system cron) so"
          " events flush promptly.\n")


async def main() -> None:
    receiver = WebhookReceiver(ws)
    app = web.Application()
    app.router.add_post("/nextcloud/webhook", receiver.handle)
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", PORT).start()
    print(f"consumer receiver listening on :{PORT}/nextcloud/webhook\n")
    print_registration_help()

    print(f"watching {MOUNT} — create/edit/delete files in the Nextcloud"
          " UI, changes stream here (Ctrl-C to stop):\n")
    try:
        async for change in ws.watch(PathSpec.from_str_path(MOUNT)):
            print(f"event: {change.kind.value} {change.path.virtual}")
            if change.kind is not FileChangeKind.DELETE:
                result = await ws.execute(f"head -c 200 {change.path.virtual}")
                fresh = (await result.stdout_str()).strip()
                print(f"  fresh content: {fresh[:80]!r}")
    finally:
        await runner.cleanup()
        await ws.close()


if __name__ == "__main__":
    asyncio.run(main())
