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

from mirage.utils.clock import Clock, SystemClock
from mirage.utils.key_prefix import under_path

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
# through `RuntimeFiles`, and those ops bubble into the enclosing line's
# records, which is exactly why admitting them here could only pair one
# op's token with another op's bytes.
# "append" is absent because no object store implements it and the
# backends that record one stamp no token.
# `truncate` would also need its record's `bytes` corrected before it
# could join: it reports 0 while its token describes `length` bytes, so
# the size check in `written_verdict` would refuse every one.
READ_FINGERPRINT_OPS = frozenset({"read"})
WRITE_FINGERPRINT_OPS = frozenset({"write"})

# What snapshot drift capture asks instead, and it is a different question
# from the cache's, so these are deliberately not the two sets above.
# `STAMP_FINGERPRINT_OPS` is a superset: capture reads the record, not the
# bytes, so it has none of the pairing problem that narrowed
# `WRITE_FINGERPRINT_OPS` to one member. The three overlap on purpose --
# a write both describes and changes, and whether it carries a token is
# what tells capture which.
#
# All three hold the op names a `record()` call spells, not the op-table
# slots: the recursive delete is the `rm_recursive` slot but records as
# "rm_r", the rename op records as "rename" or "rename_prefix"
# depending on which of its two paths ran, and a copy of a whole folder
# in one request as "copy_prefix".
STAMP_FINGERPRINT_OPS = frozenset({"read", "write", "create", "truncate"})
CONTENT_CHANGING_OPS = frozenset(
    {"write", "create", "truncate", "append", "pwrite"}
)
RETRACT_FINGERPRINT_OPS = frozenset(
    {
        "unlink",
        "rm_r",
        "rmdir",
        "rename",
        "rename_prefix",
        "copy",
        "copy_prefix",
    }
)
# Stamps name the bytes at a path; retracts mean the line no longer knows them.
VERSION_OPS = STAMP_FINGERPRINT_OPS | RETRACT_FINGERPRINT_OPS
# The subset that moved a whole prefix, and so takes every pin beneath
# it. Membership is what the op *did*, never what it could have done:
# rename has two code paths and only one of them is a prefix walk, so it
# spells them with two names. A point op must not take a subtree: it
# touched one key, and on a keyed store the keys beneath its path are
# objects of their own.
SUBTREE_RETRACT_OPS = frozenset({"rm_r", "rename_prefix", "copy_prefix"})


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
        fingerprint (str | None): On a read, on an object store's
            write, create and truncate, and on a Box, Dropbox or Google
            Drive write, the content-derived identifier the backend
            returned (e.g. S3 ``ETag``, md5, Box ``sha1``). Used to detect
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
    execution_id: str | None = None

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
            **(
                {"execution_id": self.execution_id}
                if self.execution_id is not None
                else {}
            ),
        }


class RecordIndex:
    """A line's records indexed as they arrive, for per-path version lookups.

    Each lookup first takes in the records appended since the last one, so
    a record added while a caller awaits is seen, and no record is read
    twice.

    Args:
        records (list[OpRecord]): the line's records, oldest first; only
            ever appended to.
    """

    def __init__(self, records: list[OpRecord]) -> None:
        self._records = records
        self._seen = 0
        self._at: dict[str, int] = {}
        self._subtree: list[int] = []

    def _absorb(self) -> None:
        for i in range(self._seen, len(self._records)):
            rec = self._records[i]
            if rec.op in VERSION_OPS:
                self._at[rec.path] = i
            if rec.op in SUBTREE_RETRACT_OPS:
                self._subtree.append(i)
        self._seen = len(self._records)

    def newest_version(self, key: str) -> OpRecord | None:
        """The newest record that says which version of ``key`` the line knows.

        A record at the path counts if it stamps or retracts a version; one
        at an ancestor counts if it moved the whole subtree, which took
        ``key`` with it.

        Args:
            key (str): the virtual path asked about.
        """
        self._absorb()
        at = self._at.get(key, -1)
        for i in reversed(self._subtree):
            if i <= at:
                break
            if under_path(key, self._records[i].path):
                return self._records[i]
        return self._records[at] if at >= 0 else None


@dataclass(frozen=True, slots=True)
class LostMark:
    """One lost path's mark.

    Args:
        at (int): where in the line's records it was lost.
        order (int): its place among the line's marks, from 1.
        version (str | None): the version its write lost on, if any.
    """

    at: int
    order: int
    version: str | None


@dataclass
class LostPaths:
    """The paths whose conditional write lost on this line.

    A lost path's cached copy was dropped; nothing the line read of it
    before the loss may be cached again. The version the write lost on is
    the one a retry sends, so it is refused again until a read. A read or
    write of the path after the loss names the bytes now there, and lifts
    the mark, as does removing or moving it away.

    Args:
        sink (list[OpRecord]): the line's records, shared with its frames.
        marks (dict[str, LostMark]): each lost path's mark.
        count (int): the marks made so far.
    """

    sink: list[OpRecord]
    marks: dict[str, LostMark] = field(default_factory=dict)
    count: int = 0

    def mark(self, key: str, version: str | None = None) -> None:
        """Record that a conditional write to ``key`` lost.

        Args:
            key (str): the virtual path.
            version (str | None): the version it lost on, if any.
        """
        self.count += 1
        self.marks[key] = LostMark(len(self.sink), self.count, version or None)

    def lift(self, key: str, upto: int, subtree: bool = False) -> None:
        """Lift the marks a removal or move of ``key`` made stale.

        Only marks made by the time it began: a refusal another command of
        the line made while it ran is newer than it, and stays.

        Args:
            key (str): the virtual path removed or moved.
            upto (int): ``count`` when the removal or move began.
            subtree (bool): the paths below it went too.
        """
        for marked in [
            k
            for k, m in self.marks.items()
            if (k == key or subtree and under_path(k, key)) and m.order <= upto
        ]:
            del self.marks[marked]

    def version(self, key: str) -> str | None:
        """The version a write to ``key`` lost on, while it is still lost.

        Args:
            key (str): the virtual path.
        """
        mark = self.marks.get(key)
        return mark.version if mark is not None and self.holds(key) else None

    def holds(self, key: str) -> bool:
        """Whether ``key`` is lost and nothing since has read or written it.

        Args:
            key (str): the virtual path.
        """
        mark = self.marks.get(key)
        if mark is None:
            return False
        return not any(
            rec.path == key and rec.op in STAMP_FINGERPRINT_OPS
            for rec in self.sink[mark.at :]
        )


@dataclass(frozen=True)
class Recorder:
    """Active recording state for a session.

    Bundles the sink (shared by reference across all push frames) with
    the mount_id for the current async frame. Frozen so each push is
    task-isolated: ``push_mount_context`` creates a new Recorder for
    the calling task via ``_recorder.set``, never mutates the parent.
    The sink list is the one piece that's intentionally shared, so
    records emitted from any frame land in the same collection.

    Args:
        sink (list[OpRecord]): Where new records are appended.
        lost (LostPaths): The line's lost paths.
        index (RecordIndex): The line's version index over ``sink``.
        mount_id (str | None): Identity of the mounted instance serving reads.
        ledger (list[OpRecord] | None): the workspace ledger a line hands
            its records to when it ends; None for a file call's own
            recorder, which no other call joins.
        clock (Clock): the workspace clock every op recorded here is
            timed and stamped on.
    """

    sink: list[OpRecord]
    lost: LostPaths
    index: RecordIndex
    mount_id: str | None = None
    ledger: list[OpRecord] | None = None
    clock: Clock = field(default_factory=SystemClock)
