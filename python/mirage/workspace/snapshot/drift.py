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

import logging

from mirage.types import FingerprintKey

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


async def capture_fingerprints(ws) -> list[dict]:
    """Walk session ops and capture fingerprints for every distinct
    remote read on a SUPPORTS_SNAPSHOT mount.

    Skips paths whose owning mount has ``SUPPORTS_SNAPSHOT=False``
    (live-only backends like Gmail/Slack/Linear) and paths the resource
    cannot fingerprint (``stat()`` returned ``None``). The optional
    ``revision`` (e.g. S3 ``VersionId``, Drive ``revisionId``) is
    captured alongside the fingerprint when the backend exposes one;
    load-time replay uses it to pin reads, bypassing drift detection.

    Args:
        ws: Workspace whose ops history to walk.

    Returns:
        list[dict]: One entry per fingerprinted path, with ``PATH``,
        ``MOUNT_PREFIX``, ``FINGERPRINT`` and optionally ``REVISION``.
    """
    seen: set[str] = set()
    out: list[dict] = []
    for rec in ws._ops.records:
        if rec.op != "read":
            continue
        path = rec.path
        if path in seen:
            continue
        seen.add(path)
        try:
            mount = ws._registry.mount_for(path)
        except ValueError:
            continue
        if not getattr(mount.resource, "SUPPORTS_SNAPSHOT", False):
            continue
        try:
            stat = await mount.execute_op("stat", path)
        except Exception as exc:
            logger.debug("fingerprint capture skipped %s: %s", path, exc)
            continue
        marker = getattr(stat, "fingerprint", None)
        if marker is None:
            continue
        entry: dict = {
            FingerprintKey.PATH: path,
            FingerprintKey.MOUNT_PREFIX: mount.prefix,
            FingerprintKey.FINGERPRINT: marker,
        }
        rev = getattr(stat, "revision", None)
        if rev:
            entry[FingerprintKey.REVISION] = rev
        out.append(entry)
    return out


def live_only_mount_prefixes(ws) -> list[str]:
    """Return mount prefixes whose resource opts out of snapshot replay.

    These mounts will serve current state at load time with no drift
    detection. Surfaced in the snapshot manifest so the load layer can
    log them and so users can audit which paths are non-replayable.
    """
    out: list[str] = []
    for m in ws._registry.mounts():
        if m.prefix in {"/dev/", "/.sessions/"}:
            continue
        if not getattr(m.resource, "SUPPORTS_SNAPSHOT", False):
            out.append(m.prefix)
    return out


async def check_drift(ws, path: str, recorded: str) -> None:
    """Stat `path` against its mount and raise ContentDriftError if the
    live fingerprint does not match `recorded`.

    No-op if the mount cannot be resolved or the resource cannot
    fingerprint (raises only on a real, observable mismatch).

    Args:
        ws: Workspace whose registry to consult.
        path (str): Virtual path to check.
        recorded (str): Fingerprint recorded at snapshot time.

    Raises:
        ContentDriftError: live fingerprint differs from recorded.
    """
    try:
        mount = ws._registry.mount_for(path)
    except ValueError:
        return
    if not getattr(mount.resource, "SUPPORTS_SNAPSHOT", False):
        return
    try:
        stat = await mount.execute_op("stat", path)
    except FileNotFoundError as exc:
        raise ContentDriftError(path, recorded, None) from exc
    live = getattr(stat, "fingerprint", None)
    if live is None:
        return
    if live != recorded:
        raise ContentDriftError(path, recorded, live)
