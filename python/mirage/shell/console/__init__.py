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

import importlib
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from mirage.shell.console.constants import KILLED_OUTCOME
    from mirage.shell.console.job_console import JobConsole
    from mirage.shell.console.ram import RAMConsoleStore
    from mirage.shell.console.store import ConsoleStore
    from mirage.shell.console.terminal import JobOutput, JobSide, Tee, Terminal
    from mirage.shell.console.types import (
        Channel,
        ConsoleChunk,
        OwnedStream,
        ReadResult,
    )
    from mirage.shell.console.utils import exit_outcome

_EXPORTS: dict[str, tuple[str, ...]] = {
    "mirage.shell.console.constants": ("KILLED_OUTCOME",),
    "mirage.shell.console.job_console": ("JobConsole",),
    "mirage.shell.console.ram": ("RAMConsoleStore",),
    "mirage.shell.console.store": ("ConsoleStore",),
    "mirage.shell.console.terminal": (
        "JobOutput",
        "JobSide",
        "Tee",
        "Terminal",
    ),
    "mirage.shell.console.types": (
        "Channel",
        "ConsoleChunk",
        "OwnedStream",
        "ReadResult",
    ),
    "mirage.shell.console.utils": ("exit_outcome",),
}
_MODULE_OF = {
    name: module for module, names in _EXPORTS.items() for name in names
}

__all__ = [
    "KILLED_OUTCOME",
    "Channel",
    "ConsoleChunk",
    "ConsoleStore",
    "JobConsole",
    "JobOutput",
    "JobSide",
    "OwnedStream",
    "RAMConsoleStore",
    "ReadResult",
    "Tee",
    "Terminal",
    "exit_outcome",
]


def __getattr__(name: str) -> Any:
    module = _MODULE_OF.get(name)
    if module is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(importlib.import_module(module), name)
    globals()[name] = value
    return value
