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

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Literal, Protocol, TypeAlias

from mirage.runtime.types import ByteReader, PipeWriter

# How a machine sees the workspace: ``ssh`` serves every prefix from the
# host over SFTP, ``fuse`` leaves them to the machine's own mirage, and
# ``both`` serves from the host what the machine does not mount itself.
MountType: TypeAlias = Literal["ssh", "fuse", "both"]

# What a provider does to its machine when the workspace pauses.
PauseAction: TypeAlias = Literal["pause"]


class MachineMemory(Protocol):
    """Where a workspace keeps the machines Mirage started for it, each
    its provider's id by the machine's name, so a later build of the
    workspace reaches the one it started instead of starting another.
    """

    async def recall(self, name: str) -> str | None:
        """The machine Mirage started for ``name``; None when it started
        none."""
        ...

    async def remember(self, name: str, instance: str) -> None:
        """Keep ``instance`` as the machine Mirage started for
        ``name``."""
        ...

    async def forget(self, name: str) -> None:
        """Drop the machine kept for ``name``, once it is gone."""
        ...

    async def remembered(self) -> dict[str, str]:
        """Every machine kept, its provider's id by the machine's name."""
        ...


@dataclass(frozen=True, slots=True)
class RunStatus:
    """What a run's pid line says (``RUN_WRAPPER``): its program's pid
    and start in clock ticks, None when the line gives none.
    """

    pid: int
    started: float | None


@dataclass(frozen=True, slots=True)
class MachinePipe:
    """A command a machine runs with its stdin and stdout held open.

    Args:
        reader (ByteReader): what the command writes.
        writer (PipeWriter): what the command reads.
        stop (Callable[[], Awaitable[None]]): ends the command.
        diagnostic (Callable[[], Awaitable[str]] | None): bounded startup
            diagnostics, when available.
    """

    reader: ByteReader
    writer: PipeWriter
    stop: Callable[[], Awaitable[None]]
    diagnostic: Callable[[], Awaitable[str]] | None = None


@dataclass(frozen=True, slots=True)
class ScanFacts:
    """What turns a scan's raw figures into usage: ``up_seconds`` since
    the machine booted, its clock ``ticks`` a second, its ``page`` size
    in bytes and its ``memory`` in KiB.
    """

    up_seconds: float
    ticks: int
    page: int
    memory: int
