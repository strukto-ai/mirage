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

import json
from datetime import datetime, timezone

from mirage.types import (Delta, FileChangeKind, FileEvent, FileMetadata,
                          PathSpec, WalkEntry, WalkFn)
from mirage.watch.constants import DIR_FINGERPRINT


def spec_for(root: PathSpec, virtual: str) -> PathSpec:
    """Build a PathSpec for ``virtual`` using ``root``'s mount framing.

    The mount prefix length is recovered from the (virtual,
    resource_path) pair of the root, the same arithmetic as
    ``PathSpec.dir``.

    Args:
        root (PathSpec): Watch root carrying the mount prefix.
        virtual (str): Workspace-virtual path under the same mount.
    """
    cut = len(root.virtual.rstrip("/")) - len(root.resource_path)
    return PathSpec.from_str_path(virtual,
                                  resource_path=virtual[cut:].strip("/"))


class ListingDeltaHook:
    """Generic checkpointed delta over a full backend walk.

    Snapshots the tree under the watch root as ``{virtual: fingerprint}``
    and diffs consecutive snapshots: new keys are CREATE, missing keys
    are DELETE, changed fingerprints are UPDATE. A baseline pull
    (``checkpoint=None``) establishes the snapshot and emits nothing.
    The walk callable reads the backend directly and must not go
    through mirage's caches.
    """

    def __init__(self, walk: WalkFn) -> None:
        """Args:
            walk (WalkFn): Async generator over all entries under a
                root, reading the backend directly.
        """
        self._walk = walk

    async def pull(self, root: PathSpec, checkpoint: str | None) -> Delta:
        """Walk ``root`` and diff against ``checkpoint``.

        Args:
            root (PathSpec): Watch root.
            checkpoint (str | None): JSON snapshot from the previous
                pull, or None for a baseline.
        """
        snapshot: dict[str, str] = {}
        entries: dict[str, WalkEntry] = {}
        async for entry in self._walk(root):
            entries[entry.virtual] = entry
            if entry.is_dir:
                snapshot[entry.virtual] = DIR_FINGERPRINT
            else:
                snapshot[entry.virtual] = entry.fingerprint or ""
        serialized = json.dumps(snapshot, sort_keys=True)
        if checkpoint is None:
            return Delta(changes=(), checkpoint=serialized)
        previous: dict[str, str] = json.loads(checkpoint)
        observed = datetime.now(timezone.utc)
        changes: list[FileEvent] = []
        for virtual in sorted(snapshot.keys() | previous.keys()):
            old = previous.get(virtual)
            new = snapshot.get(virtual)
            if old == new:
                continue
            if old is None and new is not None:
                kind = FileChangeKind.CREATE
            elif new is None:
                kind = FileChangeKind.DELETE
            else:
                kind = FileChangeKind.UPDATE
            current = entries.get(virtual)
            metadata = None
            if current is not None and not current.is_dir:
                metadata = FileMetadata(fingerprint=current.fingerprint,
                                        size=current.size,
                                        modified=current.modified)
            changes.append(
                FileEvent(kind=kind,
                          path=spec_for(root, virtual),
                          timestamp=observed,
                          metadata=metadata))
        return Delta(changes=tuple(changes), checkpoint=serialized)
