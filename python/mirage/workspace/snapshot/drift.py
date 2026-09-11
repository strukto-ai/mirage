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

import asyncio
import logging
from typing import TYPE_CHECKING, Any, Callable

from mirage.types import DriftPolicy
from mirage.workspace.mount.mount import MountEntry
from mirage.workspace.snapshot.keys import FingerprintKey

if TYPE_CHECKING:
    from mirage.workspace.workspace import Workspace

TryMountFor = Callable[[str], MountEntry | None]

logger = logging.getLogger(__name__)


class ContentDriftError(Exception):
    """Raised at load time when a remote resource's live fingerprint
    differs from what was recorded in the snapshot.

    Indicates the underlying source has been modified since the snapshot
    was taken, so reading current bytes would silently diverge from what
    the original agent saw. Surface to the caller rather than mask.

    Attributes:
        path (str): Virtual path that drifted.
        snapshot_fingerprint (str): Recorded marker.
        live_fingerprint (str | None): Marker observed at load time.
    """

    def __init__(self, path: str, snapshot_fingerprint: str,
                 live_fingerprint: str | None) -> None:
        self.path = path
        self.snapshot_fingerprint = snapshot_fingerprint
        self.live_fingerprint = live_fingerprint
        live_repr = repr(
            live_fingerprint) if live_fingerprint is not None else "<missing>"
        super().__init__(
            f"{path}: snapshot fingerprint {snapshot_fingerprint!r}, "
            f"live {live_repr}; data on the underlying source has changed "
            "since the snapshot was taken")


class DriftQueue:
    """Fingerprint checks a load queued, drained on the first async op.

    ``Workspace.load`` records one entry per read whose snapshot
    manifest carried a fingerprint but no stable revision (a pinned
    read needs no check: the pin guarantees the bytes). The first
    ``dispatch`` or ``execute`` drains them, so downstream code can
    rely on consistent state.
    """

    def __init__(self) -> None:
        self._entries: list[tuple[str, str, str | None]] = []
        self._pending = False

    @property
    def pending(self) -> bool:
        return self._pending

    @property
    def paths(self) -> list[str]:
        """Paths still queued for a check (audit surface)."""
        return [path for path, _, _ in self._entries]

    def queue(self,
              path: str,
              fingerprint: str,
              mount_id: str | None = None) -> None:
        """Record one path to check against its live source.

        Args:
            path (str): virtual path recorded in the snapshot.
            fingerprint (str): marker the snapshot recorded for it.
            mount_id (str | None): identity of the mount being restored.
        """
        self._entries.append((path, fingerprint, mount_id))
        self._pending = True

    async def drain(self, mount_for: TryMountFor) -> None:
        """Stat every queued path in parallel; raise on the first drift.

        Subsequent calls are no-ops. Stats are issued with
        ``asyncio.gather`` so first-op latency does not scale linearly
        with the number of recorded reads.

        Args:
            mount_for (TryMountFor): resolves a virtual path to its
                owning mount, None for none.

        Raises:
            ContentDriftError: a live fingerprint differs from the
                recorded one.
        """
        self._pending = False
        if not self._entries:
            return
        checks = [
            check_drift(mount_for, path, fingerprint, mount_id)
            for path, fingerprint, mount_id in self._entries
        ]
        self._entries.clear()
        results = await asyncio.gather(*checks, return_exceptions=True)
        for result in results:
            if isinstance(result, BaseException):
                raise result


def capture_fingerprints(ws: "Workspace", ) -> list[dict[str, Any]]:
    """Walk session ops and emit one entry per distinct read on a
    ``SUPPORTS_SNAPSHOT`` mount.

    Pure aggregation over ``ws._ops.records``. Each read ``OpRecord``
    carries the ``fingerprint`` and/or ``revision`` the backend
    returned at the moment the agent read the bytes (populated from
    the GET response, not a fresh stat at snapshot time). This avoids
    the race where the upstream changes between read and snapshot.

    Skips paths whose owning mount has ``SUPPORTS_SNAPSHOT=False``
    (live-only backends like Gmail/Slack/Linear) and reads where the
    backend returned neither marker.

    Args:
        ws: Workspace whose ops log to walk.

    Returns:
        list[dict]: One entry per (recorded, fingerprinted) path, with
        ``PATH``, ``MOUNT_PREFIX`` and at least one of ``FINGERPRINT``
        or ``REVISION``. Both may be present on versioned backends that
        return ETag and VersionId on every GET.
    """
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for rec in ws._ops.records:
        if rec.op != "read" or rec.path in seen:
            continue
        if rec.fingerprint is None and rec.revision is None:
            continue
        mount = ws._registry.try_mount_for(rec.path)
        if mount is None or (rec.mount_id is not None
                             and rec.mount_id != mount.mount_id):
            continue
        seen.add(rec.path)
        if not getattr(mount.resource, "SUPPORTS_SNAPSHOT", False):
            continue
        entry: dict[str, Any] = {
            FingerprintKey.PATH: rec.path,
            FingerprintKey.MOUNT_PREFIX: mount.prefix,
        }
        if rec.fingerprint is not None:
            entry[FingerprintKey.FINGERPRINT] = rec.fingerprint
        if rec.revision is not None:
            entry[FingerprintKey.REVISION] = rec.revision
        out.append(entry)
    return out


def install_fingerprints(
    ws: "Workspace",
    fingerprint_entries: list[dict[str, Any]],
    drift_policy: DriftPolicy,
) -> None:
    """Install snapshot fingerprints/revisions onto a reconstructed ws.

    Revisions pin replay reads to exact backend versions; bare
    fingerprints queue an eager drift check. OFF evicts the snapshot
    cache for fingerprinted paths so reads serve current state.

    Args:
        ws: the reconstructed workspace to install onto.
        fingerprint_entries: entries from a snapshot's FINGERPRINTS.
        drift_policy: STRICT queues drift checks; OFF skips and evicts.
    """
    if drift_policy == DriftPolicy.OFF:
        if fingerprint_entries:
            ws._cache.evict_paths(f[FingerprintKey.PATH]
                                  for f in fingerprint_entries)
        return
    for f in fingerprint_entries:
        path = f[FingerprintKey.PATH]
        mount = ws._registry.try_mount_for(path)
        if mount is None:
            continue
        revision = f.get(FingerprintKey.REVISION)
        if revision is not None:
            mount.revisions[path] = revision
            continue
        fingerprint = f.get(FingerprintKey.FINGERPRINT)
        if fingerprint is not None:
            ws._drift.queue(path, fingerprint, mount.mount_id)


def live_only_mount_prefixes(ws: "Workspace", ) -> list[str]:
    """Return mount prefixes whose resource opts out of snapshot replay.

    These mounts will serve current state at load time with no drift
    detection. Surfaced in the snapshot manifest so the load layer can
    log them and so users can audit which paths are non-replayable.

    The implicit scratch root is not one of them: nobody mounted it, so
    a load has nothing to warn the user about, and TypeScript, which
    keeps that anchor out of its mount table altogether, never lists it.
    """
    out: list[str] = []
    for m in ws._registry.mounts():
        if m.prefix in {"/dev/", "/.bash_history/"}:
            continue
        if ws._implicit_root and m.prefix == "/":
            continue
        if not getattr(m.resource, "SUPPORTS_SNAPSHOT", False):
            out.append(m.prefix)
    return out


async def check_drift(mount_for: TryMountFor,
                      path: str,
                      recorded: str,
                      mount_id: str | None = None) -> None:
    """Stat `path` against its mount and raise ContentDriftError if the
    live fingerprint does not match `recorded`.

    No-op if the mount cannot be resolved or the resource cannot
    fingerprint (raises only on a real, observable mismatch).

    Args:
        mount_for (TryMountFor): resolves a virtual path to its owning
            mount, None for none.
        path (str): Virtual path to check.
        recorded (str): Fingerprint recorded at snapshot time.
        mount_id (str | None): instance that owns the queued check.

    Raises:
        ContentDriftError: live fingerprint differs from recorded.
    """
    mount = mount_for(path)
    if mount is None or (mount_id is not None and mount.mount_id != mount_id):
        return
    if not getattr(mount.resource, "SUPPORTS_SNAPSHOT", False):
        return
    try:
        stat = await mount.execute_op("stat", path)
    except FileNotFoundError as exc:
        if mount_for(path) is not mount:
            return
        raise ContentDriftError(path, recorded, None) from exc
    if mount_for(path) is not mount:
        return
    live = getattr(stat, "fingerprint", None)
    if live is None:
        return
    if live != recorded:
        raise ContentDriftError(path, recorded, live)
