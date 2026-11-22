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
from collections.abc import Callable
from dataclasses import dataclass, field

from mirage.core.dev.pipe import DevicePipe
from mirage.io.async_line_iterator import AsyncLineIterator


@dataclass
class Substitution:
    """A process substitution's pipe at ``path`` on its session's devices,
    the task running its command, done once that has started (``begun``),
    and how its path is given back. A ``<( )`` its shell kept is read
    through the line buffers in ``readers``, its path given back."""

    path: str
    endpoint: DevicePipe
    task: asyncio.Task[None]
    begun: asyncio.Future[None]
    release: Callable[[], None]
    readers: list[AsyncLineIterator] = field(default_factory=list)


@dataclass
class ExpandedWords:
    """The words a simple command expanded to, its name first, filled in
    as it dispatches: what its head ran as decides which writer a closed
    pipe ends (``$cmd`` naming ``printf`` is the shell's own).
    """

    words: tuple[str, ...] | None = None
