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
from typing import Literal, TypeAlias

from mirage.runtime.types import ByteReader, PipeWriter

# How a machine sees the workspace: ``ssh`` serves every prefix from the
# host over SFTP, ``fuse`` leaves them to the machine's own mirage, and
# ``both`` serves from the host what the machine does not mount itself.
MountType: TypeAlias = Literal["ssh", "fuse", "both"]


@dataclass(frozen=True, slots=True)
class RunStatus:
    """What a run has reported on its machine (``RUN_WRAPPER``): its
    program's pid and start in clock ticks, None until it starts, and
    its exit status, None until it exits.
    """

    pid: int | None
    started: float | None
    exit_code: int | None


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
