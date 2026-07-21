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
from dataclasses import dataclass, field

from mirage.types import PathSpec
from mirage.watch.base import DeltaHook
from mirage.watch.queue.base import WatchQueue
from mirage.workspace.mount.mount import MountEntry


@dataclass(slots=True)
class Subscriber:
    """One active watch iterator: its queue and match scope.

    Args:
        queue (WatchQueue): Delivery queue owned by this subscriber.
        root_virtual (str): Watch root the subscriber asked for.
        recursive (bool): Whether descendants beyond direct children
            match.
    """
    queue: WatchQueue
    root_virtual: str
    recursive: bool


@dataclass(slots=True)
class Source:
    """One poll loop over a (mount, root) pair, shared by subscribers.

    Args:
        entry (MountEntry): Mount owning the watched subtree.
        root (PathSpec): Watch root (mount-virtual).
        hook (DeltaHook): The resource's delta hook.
        subscribers (list[Subscriber]): Active consumers.
        wake (asyncio.Event): Set by ``nudge`` to pull immediately.
        checkpoint (str | None): Opaque state of the last pull.
        task (asyncio.Task | None): The running poll loop.
    """
    entry: MountEntry
    root: PathSpec
    hook: DeltaHook
    subscribers: list[Subscriber] = field(default_factory=list)
    wake: asyncio.Event = field(default_factory=asyncio.Event)
    checkpoint: str | None = None
    task: "asyncio.Task[None] | None" = None
