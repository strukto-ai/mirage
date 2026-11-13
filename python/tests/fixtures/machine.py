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

import weakref
from collections.abc import Sequence
from dataclasses import replace
from typing import Any

from mirage.execution.machine.table import MachineTable
from mirage.machine.handle import MachineHandle
from mirage.runtime.machine import RemoteRuntime

# One table per handle, as one workspace holds a handle however many
# runtimes a test binds to it.
_TABLES: "weakref.WeakKeyDictionary[MachineHandle, MachineTable]" = (
    weakref.WeakKeyDictionary()
)


def machine_runtime(handle: MachineHandle) -> RemoteRuntime:
    """A remote runtime on one machine, bound to it as a workspace binds
    its entries, capturing what a fake handle's ``captures`` names.

    Args:
        handle (MachineHandle): the machine.
    """
    runtime = RemoteRuntime(handle.name, captures_of(handle))
    table = _TABLES.get(handle)
    if table is None:
        table = _TABLES[handle] = MachineTable({handle.name: handle})
    runtime.bind_machines(table)
    return runtime


def on(handle: MachineHandle) -> dict[str, Any]:
    """The workspace arguments that run one machine's programs, capturing
    what a fake handle's ``captures`` names.

    Args:
        handle (MachineHandle): the machine.
    """
    captures = captures_of(handle)
    if captures is not None:
        handle.config = replace(handle.config, captures=tuple(captures))
    return {"machines": {handle.name: handle}}


def captures_of(handle: MachineHandle) -> Sequence[str] | None:
    """What a test's fake handle says its runtime captures, None for a
    real one.

    Args:
        handle (MachineHandle): the machine.
    """
    captures: Sequence[str] | None = getattr(handle, "captures", None)
    return captures
