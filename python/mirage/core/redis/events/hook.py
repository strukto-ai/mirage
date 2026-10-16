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

from mirage.accessor.redis import RedisAccessor
from mirage.core.redis.events.constants import (
    DIR_SEGMENT,
    DIR_SET_VERBS,
    FILE_SEGMENT,
    REDIS_KINDS,
)
from mirage.events.payload import event_at
from mirage.types import FileChangeKind, FileEvent, JsonValue, PathSpec


class RedisEventHook:
    """Map one redis keyspace notification onto mount paths.

    The consumer subscribes to ``__keyevent@<db>__:*`` (which requires
    ``notify-keyspace-events`` to be configured; it is empty by default)
    and forwards the event verb with the key the message carried.

    Two limits are the protocol's, not this hook's, and both are
    reported honestly rather than guessed around:

    A ``set`` on a key that did not exist and one that did produce the
    same notification, so a create is reported as an UPDATE. Nothing is
    lost for a reader, because the hub evicts the parent listing for
    either, but a consumer that needs the distinction has to pull.

    A rename arrives as two independent messages (``rename_from`` with
    the old key, ``rename_to`` with the new), so reconstructing a MOVE
    would need state this hook does not keep. They map to a DELETE and
    an UPDATE, which is what a poll-diff source reports for a rename
    too.

    Directories are the third limit, and the coarsest. Every directory
    on the mount is one member of a single ``<prefix>dir`` set, and a
    keyspace message carries the key, never the member, so an external
    ``mkdir`` or ``rmdir`` says only that some directory changed. An
    empty directory has no ``file:`` key at all, so nothing else reports
    it. That maps to UNKNOWN at the mount root, which re-inventories the
    whole mount: expensive, but it is exactly what UNKNOWN means and the
    protocol offers nothing narrower.

    Keys outside those two (the ``modified:`` and ``attrs:`` side keys)
    name nothing this mount serves and map to nothing.
    """

    def __init__(self, accessor: RedisAccessor) -> None:
        """Args:
        accessor (RedisAccessor): Backend handle, read for its store.
        """
        self._accessor = accessor

    def _relative(self, key: str) -> str | None:
        """Mount-relative path for a redis key, or None if not a file.

        Args:
            key (str): The full key the notification carried.
        """
        head = f"{self._accessor.store.key_prefix}{FILE_SEGMENT}"
        if not key.startswith(head):
            return None
        return key[len(head) :]

    async def to_events(
        self, root: PathSpec, event_type: str, payload: JsonValue
    ) -> Sequence[FileEvent]:
        """Map one keyspace notification to the change it implies.

        Args:
            root (PathSpec): Any path on this mount, read for its prefix.
            event_type (str): The redis event verb (``set``, ``del``, ...).
            payload (JsonValue): The key the message carried.
        """
        if not isinstance(payload, str):
            return ()
        if payload == f"{self._accessor.store.key_prefix}{DIR_SEGMENT}":
            if event_type not in DIR_SET_VERBS:
                return ()
            return (event_at(root, "/", FileChangeKind.UNKNOWN),)
        relative = self._relative(payload)
        if relative is None:
            return ()
        kind = REDIS_KINDS.get(event_type)
        if kind is None:
            return ()
        return (event_at(root, relative, kind),)
