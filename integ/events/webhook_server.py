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

from aiohttp import web

from mirage import Workspace
from mirage.core.nextcloud.events import NextcloudEventHook
from mirage.types import PathSpec


def make_app(ws: Workspace, mount: str) -> web.Application:
    """Build the webhook receiver a consumer service would host.

    One POST route maps each ``webhook_listeners`` delivery with the
    mount's ``NextcloudEventHook`` and hands every change it implies to
    ``ws.notify``. Mirage itself hosts no server; this endpoint lives in
    the consumer's own service.

    Args:
        ws (Workspace): The workspace the Nextcloud mount is on.
        mount (str): Mirage mount root (e.g. ``/nc``).
    """
    hook = NextcloudEventHook(ws.registry.mount_for(mount).vfs.accessor)
    root = PathSpec.from_str_path(mount, vfs_path="")

    async def _handle(request: web.Request) -> web.Response:
        payload = await request.json()
        event_class = str((payload.get("event") or {}).get("class") or "")
        for change in await hook.to_events(root, event_class, payload):
            await ws.notify(change)
        return web.json_response({"ok": True})

    app = web.Application()
    app.router.add_post("/nextcloud/webhook", _handle)
    return app
