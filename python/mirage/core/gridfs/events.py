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

from mirage.accessor.gridfs import GridFSAccessor
from mirage.core.gridfs.client import files_coll
from mirage.events.payload import event_at, field, text_field
from mirage.types import FileChangeKind, FileEvent, JsonValue, PathSpec
from mirage.utils import key_prefix as kp

# Events after which the stream no longer describes the files collection
# document by document.
_GONE = frozenset({"drop", "dropDatabase", "rename", "invalidate"})


class GridFSEventHook:
    """Map one change stream event on a bucket's files collection onto
    mount paths.

    The consumer owns the stream (``watch()`` on ``<bucket>.files``,
    ideally with ``full_document_before_change`` so a delete names its
    file) and its resume token, and passes each event's
    ``operationType`` with the event. Nothing here runs a loop.

    GridFS keeps every upload as its own revision and serves the newest,
    so after an insert, a delete or a rename the hook counts the
    revisions left under each name it touched: none is a DELETE, one
    just made is a CREATE, and any other is an UPDATE, since the file
    now reads another revision. A delete names its document by id only;
    the pre-image, or the insert the hook saw, names the file, and with
    neither the whole mount is UNKNOWN. A filename ending in ``/`` is a
    directory marker. A dropped or renamed collection, a dropped
    database and an invalidated stream leave the mount UNKNOWN.
    """

    def __init__(self, accessor: GridFSAccessor) -> None:
        """Args:
        accessor (GridFSAccessor): Backend handle, read for its
            database, bucket and key prefix.
        """
        self._accessor = accessor
        self._names: dict[str, str] = {}

    def _relative(self, filename: str) -> str | None:
        """The mount-relative path of a filename, or None outside the
        mount's key prefix.

        Args:
            filename (str): The ``filename`` of a files document.
        """
        prefix = kp.normalize(self._accessor.config.key_prefix)
        if prefix and not filename.startswith(prefix):
            return None
        return filename[len(prefix) :]

    async def _settled(
        self, root: PathSpec, filename: str, made: bool
    ) -> Sequence[FileEvent]:
        """The change ``filename`` now reads as, from the revisions left.

        Args:
            root (PathSpec): Any path on this mount, read for its prefix.
            filename (str): The name an event touched.
            made (bool): Whether the event added a revision under it.
        """
        relative = self._relative(filename)
        if relative is None:
            return ()
        if relative.endswith("/"):
            kind = FileChangeKind.CREATE if made else FileChangeKind.UNKNOWN
            return (event_at(root, relative.rstrip("/"), kind),)
        left = await files_coll(self._accessor).count_documents(
            {"filename": filename}, limit=2
        )
        if left == 0:
            kind = FileChangeKind.DELETE
        elif made and left == 1:
            kind = FileChangeKind.CREATE
        else:
            kind = FileChangeKind.UPDATE
        return (event_at(root, relative, kind),)

    async def to_events(
        self, root: PathSpec, operation_type: str, payload: JsonValue
    ) -> Sequence[FileEvent]:
        """Map one change event to the changes it implies.

        Args:
            root (PathSpec): Any path on this mount, read for its prefix.
            operation_type (str): The event's ``operationType``.
            payload (JsonValue): The change event.
        """
        config = self._accessor.config
        ns = field(payload, "ns")
        if operation_type == "invalidate":
            return (event_at(root, "", FileChangeKind.UNKNOWN),)
        if text_field(ns, "db") != config.database or text_field(
            ns, "coll"
        ) not in (None, f"{config.bucket}.files"):
            return ()
        if operation_type in _GONE:
            return (event_at(root, "", FileChangeKind.UNKNOWN),)
        ident = str(field(field(payload, "documentKey"), "_id"))
        before = text_field(
            field(payload, "fullDocumentBeforeChange"), "filename"
        ) or self._names.get(ident)
        after = text_field(field(payload, "fullDocument"), "filename") or (
            text_field(
                field(field(payload, "updateDescription"), "updatedFields"),
                "filename",
            )
        )
        if operation_type == "insert" and after is not None:
            self._names[ident] = after
            return await self._settled(root, after, True)
        if operation_type == "delete":
            self._names.pop(ident, None)
            if before is None:
                return (event_at(root, "", FileChangeKind.UNKNOWN),)
            return await self._settled(root, before, False)
        if operation_type not in ("update", "replace"):
            return ()
        if before is None:
            if after is not None:
                self._names[ident] = after
            return (event_at(root, "", FileChangeKind.UNKNOWN),)
        if after is None or after == before:
            return await self._settled(root, before, False)
        self._names[ident] = after
        return (
            *await self._settled(root, before, False),
            *await self._settled(root, after, True),
        )
