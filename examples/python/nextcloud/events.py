import asyncio
import os

from aiohttp import web
from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.core.nextcloud.events import NextcloudEventHook
from mirage.types import FileChangeKind, PathSpec
from mirage.vfs.nextcloud import NextcloudConfig, NextcloudVFS

load_dotenv(".env.development")

MOUNT = "/nc"
PORT = int(os.environ.get("WEBHOOK_PORT", "8990"))

# The webhook_listeners event classes to register a webhook for.
EVENT_CLASSES = (
    "OCP\\Files\\Events\\Node\\NodeCreatedEvent",
    "OCP\\Files\\Events\\Node\\NodeWrittenEvent",
    "OCP\\Files\\Events\\Node\\NodeDeletedEvent",
    "OCP\\Files\\Events\\Node\\NodeRenamedEvent",
)

config = NextcloudConfig(
    url=os.environ["NEXTCLOUD_URL"],
    username=os.environ.get("NEXTCLOUD_USERNAME", "admin"),
    password=os.environ.get("NEXTCLOUD_PASSWORD", "admin123"),
)
vfs = NextcloudVFS(config)
ws = Workspace({MOUNT: vfs}, mode=MountMode.WRITE)


class WebhookReceiver:
    """The consumer-owned push endpoint: Nextcloud POSTs here.

    Mirage hosts no server; this receiver lives in your own service and
    just imports mirage. ``NextcloudEventHook`` maps each delivery onto
    the mount, and every change goes to ws.notify. No polling anywhere,
    no setup call: the event runtime attaches lazily on first use.
    """

    def __init__(self, workspace: Workspace) -> None:
        self._ws = workspace
        self._hook = NextcloudEventHook(vfs.accessor)
        self._root = PathSpec.from_str_path(MOUNT, vfs_path="")

    async def handle(self, request: web.Request) -> web.Response:
        payload = await request.json()
        event_class = payload.get("event", {}).get("class", "")
        for change in await self._hook.to_events(
            self._root, event_class, payload
        ):
            await self._ws.notify(change)
            print(f"webhook: {change.kind.value} {change.path.virtual}")
        return web.json_response({"ok": True})


def print_registration_help() -> None:
    """Print the one-time Nextcloud setup for push delivery."""
    callback = os.environ.get(
        "WEBHOOK_CALLBACK",
        f"http://host.docker.internal:{PORT}/nextcloud/webhook",
    )
    base = config.url.split("/remote.php")[0]
    print("One-time Nextcloud setup (admin):")
    print("  1. Enable the app:  occ app:enable webhook_listeners")
    print("  2. Register one webhook per event class, e.g.:")
    for cls in EVENT_CLASSES:
        escaped = cls.replace("\\", "\\\\")
        print(
            f'     curl -u {config.username}:*** -H "OCS-APIRequest: true"'
            f' -H "Content-Type: application/json"'
            f" -X POST {base}/ocs/v2.php/apps/webhook_listeners"
            f"/api/v1/webhooks/register"
            f' -d \'{{"httpMethod": "POST", "uri": "{callback}",'
            f' "event": "{escaped}"}}\''
        )
    print(
        "  3. Delivery rides Nextcloud background jobs; with the docker"
        " image run `occ background:cron` (or enable system cron) so"
        " events flush promptly.\n"
    )


async def main() -> None:
    receiver = WebhookReceiver(ws)
    app = web.Application()
    app.router.add_post("/nextcloud/webhook", receiver.handle)
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", PORT).start()
    print(f"consumer receiver listening on :{PORT}/nextcloud/webhook\n")
    print_registration_help()

    print(
        f"listening on {MOUNT}: create/edit/delete files in the Nextcloud"
        " UI, changes stream here (Ctrl-C to stop):\n"
    )
    try:
        async for change in ws.events(PathSpec.from_str_path(MOUNT)):
            print(f"event: {change.kind.value} {change.path.virtual}")
            if change.kind is not FileChangeKind.DELETE:
                result = await ws.shell(f"head -c 200 {change.path.virtual}")
                fresh = (await result.stdout_str()).strip()
                print(f"  fresh content: {fresh[:80]!r}")
    finally:
        await runner.cleanup()
        await ws.close()


if __name__ == "__main__":
    asyncio.run(main())
