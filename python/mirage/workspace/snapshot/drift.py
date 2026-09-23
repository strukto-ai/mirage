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

from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.observe.record import (CONTENT_CHANGING_OPS,
                                   RETRACT_FINGERPRINT_OPS,
                                   STAMP_FINGERPRINT_OPS, SUBTREE_RETRACT_OPS)
from mirage.types import DriftPolicy
from mirage.workspace.mount.mount import MountEntry
from mirage.workspace.snapshot.keys import FingerprintKey

if TYPE_CHECKING:
    from mirage.workspace.workspace import Workspace

TryMountFor = Callable[[str], MountEntry | None]

logger = logging.getLogger(__name__)


class ContentDriftError(Exception):
    """Raised at load time when a remote VFS's live fingerprint
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
    ``dispatch`` or ``shell`` drains them, so downstream code can
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


def _drop_pin(out: dict[str, dict[str, Any]], path: str, subtree: bool,
              owner: str | None) -> None:
    """Drop the pin at ``path``, and every pin beneath it for a prefix op.

    Normalizes the probe, never the stored key: a mount-root op is
    spelled ``/s3/`` here and ``/s3`` in TypeScript, and an unnormalized
    prefix test would drop nothing in one language and a whole mount in
    the other. The stored keys stay as recorded, so the snapshot's
    ``PATH`` values are unchanged.

    Args:
        out (dict[str, dict[str, Any]]): the pins built so far, keyed by
            virtual path.
        path (str): the path the retracting record named.
        subtree (bool): True for an op that can move a whole prefix
            (``rm_r``, ``rename``). A point op drops only its own pin:
            on a keyed store ``a`` and ``a/b`` are both objects, and
            ``rm a`` leaves ``a/b`` alone.
        owner (str | None): mount prefix the retracting record belongs
            to, which bounds the subtree sweep; None when the mount no
            longer resolves, and the sweep is then unbounded, because
            dropping a pin is the safe direction.
    """
    base = path.rstrip("/")
    out.pop(base, None)
    if not subtree:
        return
    # A nested mount's keys live in a different backend, so an op on the
    # parent never touched them. That matters most for a mount at "/",
    # where `base` is "" and every virtual path is "under" it: an
    # unbounded sweep there would drop every other mount's pins and
    # silently lose their drift check.
    prefix = base + "/"
    for key, entry in list(out.items()):
        if not key.startswith(prefix):
            continue
        if owner is not None and entry.get(
                FingerprintKey.MOUNT_PREFIX) != owner:
            continue
        out.pop(key)


def capture_fingerprints(ws: "Workspace", ) -> list[dict[str, Any]]:
    """Walk session ops and emit one pin per path still worth checking.

    A single forward pass over the time-ordered records, so the last word
    on a path wins. Three things can be that last word:

    * an op that removed or replaced the object (``RETRACT_FINGERPRINT_OPS``)
      drops the pin, and every pin beneath it -- ``rm -r`` and a prefix
      rename take a subtree with them;
    * an op that changed the bytes without describing them -- a write
      whose backend returned no token, or any ``append`` -- drops the pin
      too, because the token on file no longer names what is there;
    * an op carrying a token (``STAMP_FINGERPRINT_OPS``) replaces the pin
      whole, never field-merging, so a read's revision cannot survive
      onto a later write's fingerprint and pin replay to pre-write bytes.

    A read that reported no token changes nothing and leaves the pin
    alone. Each token is what the backend returned at the moment the
    agent moved the bytes, not a fresh stat at snapshot time, which
    avoids the race where the upstream changes in between.

    Paths on a mount that opts out of snapshot replay (``Gmail``,
    ``Slack``, ``Linear``) are never pinned; a retraction still applies
    to them, because dropping a pin is the safe direction and the mount
    a retraction names may no longer be the one that set the pin.

    Args:
        ws (Workspace): workspace whose ops log to walk.

    Returns:
        list[dict]: one entry per surviving path, with ``PATH``,
        ``MOUNT_PREFIX`` and at least one of ``FINGERPRINT`` or
        ``REVISION``. Both may be present on versioned backends that
        return ETag and VersionId on every GET.
    """
    out: dict[str, dict[str, Any]] = {}
    # By timestamp, not by position: a backend record reaches this list
    # only when its line ends (`execute.py`), while an `Ops` facade
    # record appends as it happens, so the list is flush-ordered and a
    # retraction can otherwise sit before the write it retracts. The
    # sort is stable, so same-millisecond records keep their order.
    for rec in sorted(ws._ops.records, key=lambda r: r.timestamp):
        if rec.op in RETRACT_FINGERPRINT_OPS:
            # Resolved to bound the sweep, never to gate the drop: a
            # retraction whose mount has since gone still applies.
            retracted = ws._registry.try_mount_for(rec.path)
            _drop_pin(out, rec.path, rec.op in SUBTREE_RETRACT_OPS,
                      retracted.prefix if retracted is not None else None)
            continue
        if (rec.op in CONTENT_CHANGING_OPS
                and (rec.op not in STAMP_FINGERPRINT_OPS
                     or not (rec.fingerprint or rec.revision))):
            # Dropped unless the token can actually be used below: an op
            # outside STAMP never reaches the stamping arm, so keeping
            # its pin would leave the pre-change token describing bytes
            # that changed. `append` is the live member of that shape.
            _drop_pin(out, rec.path, False, None)
            continue
        if rec.op not in STAMP_FINGERPRINT_OPS:
            continue
        if rec.fingerprint is None and rec.revision is None:
            continue
        mount = ws._registry.try_mount_for(rec.path)
        if mount is None or (rec.mount_id is not None
                             and rec.mount_id != mount.mount_id):
            continue
        if not getattr(mount.vfs, "SUPPORTS_SNAPSHOT", False):
            continue
        entry: dict[str, Any] = {
            FingerprintKey.PATH: rec.path,
            FingerprintKey.MOUNT_PREFIX: mount.prefix,
        }
        if rec.fingerprint is not None:
            entry[FingerprintKey.FINGERPRINT] = rec.fingerprint
        if rec.revision is not None:
            entry[FingerprintKey.REVISION] = rec.revision
        out[rec.path] = entry
    return list(out.values())


def install_fingerprints(
    ws: "Workspace",
    fingerprint_entries: list[dict[str, Any]],
    drift_policy: DriftPolicy,
) -> None:
    """Install snapshot fingerprints/revisions onto a reconstructed ws.

    Revisions pin replay reads to exact backend versions; bare
    fingerprints queue an eager drift check. OFF drops the restored RAM
    cache entries for fingerprinted paths so reads serve current state;
    a Redis cache is never restored from a snapshot (``_restore_cache``
    skips it), so its ``evict_paths`` is a documented no-op and there
    is nothing to drop.

    Args:
        ws: the reconstructed workspace to install onto.
        fingerprint_entries: entries from a snapshot's FINGERPRINTS.
        drift_policy: STRICT queues drift checks; OFF skips them and
            drops the restored cache entries.
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
    """Return mount prefixes whose VFS opts out of snapshot replay.

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
        if not getattr(m.vfs, "SUPPORTS_SNAPSHOT", False):
            out.append(m.prefix)
    return out


async def check_drift(mount_for: TryMountFor,
                      path: str,
                      recorded: str,
                      mount_id: str | None = None) -> None:
    """Stat `path` against its mount and raise ContentDriftError if the
    live fingerprint does not match `recorded`.

    No-op if the mount cannot be resolved or the VFS cannot
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
    if not getattr(mount.vfs, "SUPPORTS_SNAPSHOT", False):
        return
    # Resolve backend IDs afresh without consulting the restored index.
    try:
        stat = await mount.execute_op("stat", path, index=RAMIndexCacheStore())
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
