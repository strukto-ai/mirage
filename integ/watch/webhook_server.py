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

from datetime import datetime, timezone

from aiohttp import web

from mirage.types import FileChangeKind, FileEvent, PathSpec

# Nextcloud webhook_listeners event class -> mirage change kind.
_KIND_BY_CLASS = {
    "OCP\\Files\\Events\\Node\\NodeCreatedEvent": FileChangeKind.CREATE,
    "OCP\\Files\\Events\\Node\\NodeWrittenEvent": FileChangeKind.UPDATE,
    "OCP\\Files\\Events\\Node\\NodeTouchedEvent": FileChangeKind.UPDATE,
    "OCP\\Files\\Events\\Node\\NodeDeletedEvent": FileChangeKind.DELETE,
    "OCP\\Files\\Events\\Node\\NodeRenamedEvent": FileChangeKind.MOVE,
}


def _to_virtual(node_path: str, files_prefix: str, mount: str) -> str:
    """Translate a Nextcloud node path to a mirage virtual path.

    Nextcloud reports ``/<user>/files/<rel>``; the mount is rooted at
    the same ``<user>/files`` directory, so stripping the prefix and
    prepending the mount yields the virtual path.

    Args:
        node_path (str): ``node.path`` from the payload.
        files_prefix (str): The ``/<user>/files`` prefix to strip.
        mount (str): Mirage mount root (e.g. ``/nc``).
    """
    prefix = "/" + files_prefix.strip("/")
    rel = node_path[len(prefix):] if node_path.startswith(
        prefix) else node_path
    return mount.rstrip("/") + "/" + rel.strip("/")


def nextcloud_change(payload: dict, files_prefix: str,
                     mount: str) -> FileEvent | None:
    """Map one Nextcloud webhook payload to a FileEvent.

    Returns None for event classes the watcher does not model.

    Args:
        payload (dict): Decoded webhook_listeners POST body.
        files_prefix (str): The ``/<user>/files`` prefix to strip.
        mount (str): Mirage mount root.
    """
    event = payload.get("event", {})
    kind = _KIND_BY_CLASS.get(event.get("class", ""))
    if kind is None:
        return None
    observed = datetime.fromtimestamp(int(payload.get("time", 0)),
                                      tz=timezone.utc)
    if kind is FileChangeKind.MOVE:
        source = event.get("source", {}).get("path", "")
        target = event.get("target", {}).get("path", "")
        return FileEvent(kind=kind,
                         path=PathSpec.from_str_path(
                             _to_virtual(target, files_prefix, mount)),
                         previous_path=PathSpec.from_str_path(
                             _to_virtual(source, files_prefix, mount)),
                         timestamp=observed)
    node_path = event.get("node", {}).get("path", "")
    return FileEvent(kind=kind,
                     path=PathSpec.from_str_path(
                         _to_virtual(node_path, files_prefix, mount)),
                     timestamp=observed)


def make_app(sink: object, files_prefix: str, mount: str) -> web.Application:
    """Build the webhook receiver a consumer service would host.

    One POST route decodes the payload, maps it, and injects it via
    ``sink.notify``. Mirage itself hosts no server; this endpoint
    lives in the consumer's own service.

    Args:
        sink (object): Anything with ``notify`` — the workspace
            itself, or a ``Watcher`` attached to one.
        files_prefix (str): The ``/<user>/files`` prefix to strip.
        mount (str): Mirage mount root.
    """

    async def _handle(request: web.Request) -> web.Response:
        payload = await request.json()
        change = nextcloud_change(payload, files_prefix, mount)
        if change is not None:
            await sink.notify(change)
        return web.json_response({"ok": True})

    app = web.Application()
    app.router.add_post("/nextcloud/webhook", _handle)
    return app
