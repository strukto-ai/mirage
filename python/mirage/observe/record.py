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


@dataclass
class OpRecord:
    """A single observed I/O operation.

    Args:
        op (str): Operation type ("read", "write", "stat", "readdir", etc.).
        path (str): Virtual path (mount_prefix + rel_path).
        source (str): Resource name ("s3", "ram", "disk").
        bytes (int): Bytes transferred (0 for metadata ops).
        timestamp (int): UTC epoch milliseconds.
        duration_ms (int): Wall-clock duration.
        mount_prefix (str): The mount prefix this op was served through
            (e.g. "/s3"). Empty when recorded outside any mount frame.
            Stored explicitly so consumers don't have to re-derive it
            from the virtual path.
        fingerprint (str | None): For read ops on a backend that supports
            snapshot+replay, the content-derived identifier the backend
            returned (e.g. S3 ``ETag``, md5). Used to detect drift at
            replay time. Captured at read time so the snapshot reflects
            what the agent actually saw. None for writes, metadata ops,
            and backends without snapshot support.
        revision (str | None): For read ops on a backend that exposes
            stable revision handles (S3 ``VersionId``, Drive
            ``revisionId``, Git commit SHA), the value the backend
            returned. Used to pin reads at replay time so the original
            bytes can be re-fetched even if the live object has moved on.
            Strictly stronger than ``fingerprint`` — populated only by
            backends that can guarantee revision durability.
    """

    op: str
    path: str
    source: str
    bytes: int
    timestamp: int
    duration_ms: int
    mount_prefix: str = field(default="")
    fingerprint: str | None = field(default=None)
    revision: str | None = field(default=None)

    @property
    def is_cache(self) -> bool:
        """Whether this op was served from the in-memory cache."""
        return self.source == "ram"

    @property
    def rel_path(self) -> str:
        """Path relative to the mount root (strips mount_prefix)."""
        if self.mount_prefix and self.path.startswith(self.mount_prefix):
            return self.path[len(self.mount_prefix):] or "/"
        return self.path
