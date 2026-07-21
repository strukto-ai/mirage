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
import time
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass

from mirage.types import ChangeKind, Delta, PathSpec, ResourceChange
from mirage.watch.constants import DIR_DETECTOR


@dataclass(frozen=True, slots=True)
class WalkEntry:
    """One entry produced by a backend walk.

    Args:
        virtual (str): Workspace-virtual path of the entry.
        is_dir (bool): Whether the entry is a directory.
        detector (str | None): Opaque change detector (ETag, or an
            mtime|size composite). None means only create/delete are
            detectable for this entry.
    """
    virtual: str
    is_dir: bool
    detector: str | None


WalkFn = Callable[[PathSpec], AsyncIterator[WalkEntry]]


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

    Snapshots the tree under the watch root as ``{virtual: detector}``
    and diffs consecutive snapshots: new keys are CREATE, missing keys
    are DELETE, changed detectors are UPDATE. A baseline pull
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
        async for entry in self._walk(root):
            if entry.is_dir:
                snapshot[entry.virtual] = DIR_DETECTOR
            else:
                snapshot[entry.virtual] = entry.detector or ""
        serialized = json.dumps(snapshot, sort_keys=True)
        if checkpoint is None:
            return Delta(changes=(), checkpoint=serialized)
        previous: dict[str, str] = json.loads(checkpoint)
        observed = int(time.time() * 1000)
        changes: list[ResourceChange] = []
        for virtual in sorted(snapshot.keys() | previous.keys()):
            old = previous.get(virtual)
            new = snapshot.get(virtual)
            if old == new:
                continue
            if old is None and new is not None:
                kind = ChangeKind.CREATE
            elif new is None:
                kind = ChangeKind.DELETE
            else:
                kind = ChangeKind.UPDATE
            changes.append(
                ResourceChange(kind=kind,
                               path=spec_for(root, virtual),
                               observed_at_ms=observed,
                               version=new if new not in (None, DIR_DETECTOR,
                                                          "") else None))
        return Delta(changes=tuple(changes), checkpoint=serialized)
