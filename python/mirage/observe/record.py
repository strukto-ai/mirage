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

from dataclasses import dataclass, field

# Ops whose record carries a token describing the bytes it moved, split
# by direction: the file cache stores bytes from either `IOResult.reads`
# or `IOResult.writes` and must ask about the side it took, since one
# line can carry both for a path.
#
# `create` and `truncate` stamp a token on their own record too, but
# neither ever hands bytes to the cache: no command builder can ask for
# a create (`Operation` has no member for it) and truncate's command
# returns an empty IOResult, so no created or truncated path is ever
# listed in `IOResult.cache`. A script runtime can still issue either
# through `RuntimeVFS`, and those ops bubble into the enclosing line's
# records, which is exactly why admitting them here could only pair one
# op's token with another op's bytes.
# "append" is absent because no object store implements it and the
# backends that record one stamp no token.
READ_FINGERPRINT_OPS = frozenset({"read"})
WRITE_FINGERPRINT_OPS = frozenset({"write"})


@dataclass
class OpRecord:
    """A single observed I/O operation.

    Args:
        op (str): Operation type ("read", "write", "stat", "readdir", etc.).
        path (str): Virtual path, mount prefix included.
        source (str): VFS name ("s3", "ram", "disk").
        bytes (int): Bytes transferred (0 for metadata ops).
        timestamp (int): UTC epoch milliseconds.
        duration_ms (int): Wall-clock duration.
        fingerprint (str | None): On a read, and on an object store's
            write, create and truncate, the content-derived identifier
            the backend returned (e.g. S3 ``ETag``, md5). Used to detect
            drift at replay time. Captured as the op completes, so it
            describes the bytes that op moved. None for metadata ops and
            backends that return no token.
        revision (str | None): For read ops on a backend that exposes
            stable revision handles (S3 ``VersionId``, Drive
            ``revisionId``, Git commit SHA), the value the backend
            returned. Used to pin reads at replay time so the original
            bytes can be re-fetched even if the live object has moved on.
            Strictly stronger than ``fingerprint`` — populated only by
            backends that can guarantee revision durability.
        mount_id (str | None): In-process mount identity for snapshot
            ownership checks; never used as a persisted backend revision.
    """

    op: str
    path: str
    source: str
    bytes: int
    timestamp: int
    duration_ms: int
    fingerprint: str | None = field(default=None)
    revision: str | None = field(default=None)
    mount_id: str | None = field(default=None, repr=False, compare=False)

    @property
    def is_cache(self) -> bool:
        """Whether this op was served from the in-memory cache."""
        return self.source == "ram"

    def to_dict(self) -> dict[str, str | int | None]:
        """Public observation fields, excluding in-process mount ownership."""
        return {
            "op": self.op,
            "path": self.path,
            "source": self.source,
            "bytes": self.bytes,
            "timestamp": self.timestamp,
            "duration_ms": self.duration_ms,
            "fingerprint": self.fingerprint,
            "revision": self.revision,
        }
