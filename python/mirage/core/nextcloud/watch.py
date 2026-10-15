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

from collections.abc import Sequence
from urllib.parse import unquote, urlsplit

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.types import FileChangeKind, FileEvent, JsonValue, PathSpec
from mirage.vfs.secrets import reveal_secret
from mirage.watch.events import event_at, field, text_field

# The node event classes ``webhook_listeners`` sends, and the change
# each one is.
_KIND_BY_CLASS = {
    "OCP\\Files\\Events\\Node\\NodeCreatedEvent": FileChangeKind.CREATE,
    "OCP\\Files\\Events\\Node\\NodeWrittenEvent": FileChangeKind.UPDATE,
    "OCP\\Files\\Events\\Node\\NodeTouchedEvent": FileChangeKind.UPDATE,
    "OCP\\Files\\Events\\Node\\NodeDeletedEvent": FileChangeKind.DELETE,
    "OCP\\Files\\Events\\Node\\NodeRenamedEvent": FileChangeKind.MOVE,
}

_DAV = "/remote.php/dav/files/"
_WEBDAV = "/remote.php/webdav"


class NextcloudEventHook:
    """Map one Nextcloud ``webhook_listeners`` delivery onto mount paths.

    The consumer registers a webhook for the node events (Nextcloud 30
    and later) and passes each delivery's ``event.class`` with its body.
    Nothing here runs a loop. A delivery names the node by its path in
    the instance, ``/<user>/files/<path>``; the mount is rooted at the
    WebDAV folder its URL names, so the hook reads that root from the
    URL and maps only the nodes below it. A rename into the mount is a
    CREATE and one out of it a DELETE; a folder above the mount root
    deleted or renamed away removes the root, and one made or renamed
    into place leaves it UNKNOWN. Any other node outside it, or an event
    class the watcher does not model, maps to nothing.
    """

    def __init__(self, accessor: NextcloudAccessor) -> None:
        """Args:
        accessor (NextcloudAccessor): Backend handle, read for its URL
            and user.
        """
        self._root = _files_root(accessor)

    def _relative(self, node: str | None) -> str | None:
        """The mount-relative path of an instance path, or None when it
        is outside the mount.

        Args:
            node (str | None): ``/<user>/files/<path>``.
        """
        root = self._root
        if node is None or root is None:
            return None
        node = node.rstrip("/")
        if node == root:
            return ""
        return node[len(root) + 1 :] if node.startswith(root + "/") else None

    def _above(self, node: str | None) -> bool:
        """Whether an instance path is a folder the mount root sits below.

        Args:
            node (str | None): ``/<user>/files/<path>``.
        """
        root = self._root
        if node is None or root is None:
            return False
        return root.startswith(node.rstrip("/") + "/")

    async def to_events(
        self, root: PathSpec, event_class: str, payload: JsonValue
    ) -> Sequence[FileEvent]:
        """Map one delivery to the change it implies.

        Args:
            root (PathSpec): Any path on this mount, read for its prefix.
            event_class (str): The delivery's ``event.class``.
            payload (JsonValue): The delivery's JSON body.
        """
        kind = _KIND_BY_CLASS.get(event_class)
        event = field(payload, "event")
        if kind is None:
            return ()
        if kind is not FileChangeKind.MOVE:
            node = text_field(field(event, "node"), "path")
            place = self._relative(node)
            if place is not None:
                return (event_at(root, place, kind),)
            if self._above(node) and kind is not FileChangeKind.UPDATE:
                gone = kind is FileChangeKind.DELETE
                kind = (
                    FileChangeKind.DELETE if gone else FileChangeKind.UNKNOWN
                )
                return (event_at(root, "", kind),)
            return ()
        source_path = text_field(field(event, "source"), "path")
        target_path = text_field(field(event, "target"), "path")
        if self._above(source_path):
            return (event_at(root, "", FileChangeKind.DELETE),)
        if self._above(target_path):
            return (event_at(root, "", FileChangeKind.UNKNOWN),)
        source = self._relative(source_path)
        target = self._relative(target_path)
        if source is not None and target is not None:
            return (event_at(root, target, kind, previous=source),)
        if target is not None:
            return (event_at(root, target, FileChangeKind.CREATE),)
        if source is not None:
            return (event_at(root, source, FileChangeKind.DELETE),)
        return ()


def _files_root(accessor: NextcloudAccessor) -> str | None:
    """The instance path the mount's WebDAV URL is rooted at,
    ``/<user>/files[/<folder>]``, or None for a URL of another shape.

    Args:
        accessor (NextcloudAccessor): Backend handle.
    """
    config = accessor.config
    path = unquote(urlsplit(config.url).path).rstrip("/")
    if _DAV in path + "/":
        user, _, folder = (path + "/").split(_DAV, 1)[1].partition("/")
    elif _WEBDAV in path and (named := reveal_secret(config.username)):
        user, folder = named, path.split(_WEBDAV, 1)[1]
    else:
        return None
    return f"/{user}/files/{folder.strip('/')}".rstrip("/")
