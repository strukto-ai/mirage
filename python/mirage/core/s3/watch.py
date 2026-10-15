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
from urllib.parse import unquote_plus

from mirage.accessor.s3 import S3Accessor
from mirage.types import FileChangeKind, FileEvent, JsonValue, PathSpec
from mirage.utils import key_prefix as kp
from mirage.watch.events import event_at, field, text_field

# The eventName families a record carries: a write (Put, Post, Copy,
# CompleteMultipartUpload) or a removal (Delete, DeleteMarkerCreated,
# lifecycle expiry).
_WRITTEN = "ObjectCreated:"
_REMOVED = ("ObjectRemoved:", "LifecycleExpiration:")


class S3EventHook:
    """Map one S3 event notification record onto mount paths.

    The consumer owns the transport (S3 Event Notifications delivered to
    an SQS queue, an SNS topic or EventBridge) and passes each record of
    a notification's ``Records`` with its ``eventName``. Nothing here
    runs a loop. A record names the bucket and the object key,
    URL-encoded with ``+`` for a space, and says whether the object was
    written or removed.

    S3 does not say whether a write made the object or replaced it, so
    a key the hook has mapped before is an UPDATE and any other is a
    CREATE, as the Box hook splits an upload. A key ending in ``/`` is a
    directory marker: writing one makes the directory, and removing one
    leaves whatever is below it, so that directory is UNKNOWN. A record
    for another bucket, or for a key outside the mount's ``key_prefix``,
    maps to nothing.
    """

    def __init__(self, accessor: S3Accessor) -> None:
        """Args:
        accessor (S3Accessor): Backend handle, read for its bucket and
            key prefix.
        """
        self._accessor = accessor
        self._seen: set[str] = set()

    async def to_events(
        self, root: PathSpec, event_name: str, payload: JsonValue
    ) -> Sequence[FileEvent]:
        """Map one notification record to the change it implies.

        Args:
            root (PathSpec): Any path on this mount, read for its prefix.
            event_name (str): The record's ``eventName``.
            payload (JsonValue): One record from ``Records``.
        """
        config = self._accessor.config
        s3 = field(payload, "s3")
        key = text_field(field(s3, "object"), "key")
        if text_field(field(s3, "bucket"), "name") != config.bucket or not key:
            return ()
        key = unquote_plus(key)
        prefix = kp.normalize(config.key_prefix)
        if prefix and not key.startswith(prefix):
            return ()
        relative = key[len(prefix) :]
        if relative.endswith("/"):
            place = relative.rstrip("/")
            if not place:
                return ()
            kind = (
                FileChangeKind.CREATE
                if event_name.startswith(_WRITTEN)
                else FileChangeKind.UNKNOWN
            )
            return (event_at(root, place, kind),)
        if event_name.startswith(_REMOVED):
            self._seen.discard(relative)
            return (event_at(root, relative, FileChangeKind.DELETE),)
        if not event_name.startswith(_WRITTEN):
            return ()
        kind = (
            FileChangeKind.UPDATE
            if relative in self._seen
            else FileChangeKind.CREATE
        )
        self._seen.add(relative)
        return (event_at(root, relative, kind),)
