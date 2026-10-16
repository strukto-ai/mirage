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
from pathlib import Path

from mirage.accessor.disk import DiskAccessor
from mirage.core.disk.events.constants import DISK_KINDS
from mirage.events.payload import event_at, text_field
from mirage.types import FileChangeKind, FileEvent, JsonValue, PathSpec


class DiskEventHook:
    """Map one local filesystem notification onto mount paths.

    Mirage runs no watcher of its own: the consumer owns the inotify /
    FSEvents / ReadDirectoryChangesW loop (watchdog, chokidar, or the
    raw syscall) and forwards what it saw, which keeps the dependency
    out of the package and lets a deployment pick its own mechanism.

    ``event_type`` is one of ``created``, ``modified``, ``deleted`` or
    ``moved``, so a consumer translates its library's spelling once
    (watchdog's ``created``/``modified``/``deleted``/``moved`` already
    match; chokidar's ``add``/``addDir`` are ``created``, ``unlink``/
    ``unlinkDir`` are ``deleted``, ``change`` is ``modified``). Any
    other name maps to nothing, because a watcher reports events this
    mount has no opinion about.

    ``payload`` carries the host absolute paths the event named:
    ``{"src_path": ..., "dest_path": ..., "is_directory": ...}``. Those
    are watchdog's own field names, taken verbatim from
    ``FileSystemEvent`` so a consumer can forward an event as a dict
    without renaming anything.
    """

    def __init__(self, accessor: DiskAccessor) -> None:
        """Args:
        accessor (DiskAccessor): Backend handle, read for its root.
        """
        self._accessor = accessor

    def _relative(self, host_path: str) -> str | None:
        """Mount-relative form of a host path, or None if outside.

        A watcher may be rooted above the mount, so an event for a
        sibling directory is not this mount's to report.

        Args:
            host_path (str): Absolute path on the local filesystem.
        """
        try:
            relative = (
                Path(host_path).relative_to(self._accessor.root).as_posix()
            )
        except ValueError:
            return None
        # `relative_to` spells "the root itself" as ".", which would
        # render as a fabricated "<mount>/." entry.
        return "/" if relative == "." else "/" + relative

    async def to_events(
        self, root: PathSpec, event_type: str, payload: JsonValue
    ) -> Sequence[FileEvent]:
        """Map one filesystem notification to the change it implies.

        A directory's own ``modified`` stays an UPDATE rather than
        becoming UNKNOWN: inotify raises it whenever a child appears or
        vanishes, and it also delivers that child's own event, so
        re-inventorying the subtree on every write inside a directory
        would throw away the whole cache for no new information.

        Args:
            root (PathSpec): Any path on this mount, read for its prefix.
            event_type (str): ``created``, ``modified``, ``deleted`` or
                ``moved``.
            payload (JsonValue): ``src_path`` plus, for a move,
                ``dest_path``.
        """
        source = text_field(payload, "src_path")
        target = text_field(payload, "dest_path")
        if event_type == "moved":
            return self._moved(root, source, target)
        if source is None:
            return ()
        relative = self._relative(source)
        if relative is None:
            return ()
        kind = DISK_KINDS.get(event_type)
        if kind is None:
            return ()
        return (event_at(root, relative, kind),)

    def _moved(
        self, root: PathSpec, source: str | None, target: str | None
    ) -> Sequence[FileEvent]:
        """Map a rename, which may cross the mount boundary either way.

        A watcher rooted above the mount sees renames that only half
        belong here, and each half has to be reported on its own terms:
        a move out is a DELETE of the vacated path, and a move in is a
        CREATE of the arrival. Reporting neither (which discarding the
        event on an out-of-mount source does) leaves a file sitting in
        the mount that no listing knows about.

        Args:
            root (PathSpec): Any path on this mount, read for its prefix.
            source (str | None): Host path the entry left, if named.
            target (str | None): Host path the entry arrived at, if named.
        """
        moved_from = self._relative(source) if source is not None else None
        moved_to = self._relative(target) if target is not None else None
        if moved_to is None:
            if moved_from is None:
                return ()
            return (event_at(root, moved_from, FileChangeKind.DELETE),)
        if moved_from is None:
            return (event_at(root, moved_to, FileChangeKind.CREATE),)
        return (event_at(root, moved_to, FileChangeKind.MOVE, moved_from),)
