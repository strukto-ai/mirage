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

from typing import Any, Callable

from mirage.runtime.base import Runtime
from mirage.runtime.js.quickjs import QuickJsRuntime
from mirage.runtime.python.local import LocalRuntime
from mirage.runtime.python.monty import MontyRuntime
from mirage.runtime.python.wasi import WasiRuntime

# One source of truth, preference order (sandboxed first, host last).
# The command -> runtime mapping is derived from each class's captures,
# never hand-maintained.
RUNTIMES: tuple[type[Runtime], ...] = (MontyRuntime, WasiRuntime, LocalRuntime,
                                       QuickJsRuntime)

NAMED: dict[str, type[Runtime]] = {cls.name: cls for cls in RUNTIMES}

VFS_ENTRY = "vfs"


class VfsEntry(Runtime):
    """The vfs executor as an ordinary, scriptable entry.

    The plain "vfs" string is the unconditional form; this class exists
    so the vfs rung can carry a route script like any other entry
    (e.g. refuse oversized lines). It captures nothing and never runs:
    the workspace executor itself serves the commands it admits.

    Args:
        script (Callable | str | None): per-line admission script, the
            same contract as any runtime's script.
    """

    name = VFS_ENTRY
    captures: tuple[str, ...] = ()

    def __init__(self,
                 script: "Callable[..., Any] | str | None" = None) -> None:
        self.script = script

    async def run(self, args: Any) -> Any:
        raise RuntimeError("the vfs entry is an ordering marker; the "
                           "workspace executor runs its commands")


# The default world when no runtimes list is given: today's behavior
# exactly. Defaults build gracefully (a missing extra leaves the
# command reporting its install hint per invocation); an explicitly
# listed name still fails loud. `local` is deliberately absent: a
# sandboxed default must never silently escalate to host execution.
DEFAULT_ENTRIES: tuple[str, ...] = ("monty", "quickjs", VFS_ENTRY)

# TypeScript-only runtime names a cross-language config may carry.
TS_ONLY_HINTS: dict[str, str] = {
    "pyodide": ("runtime 'pyodide' is TypeScript-only (a WASM CPython for "
                "runtimes without a host Python); Python supports 'monty' "
                "(sandboxed, default), 'wasi' (sandboxed full CPython), "
                "'local' (the host CPython), and 'quickjs' (sandboxed "
                "JavaScript)"),
}


def candidates(command: str) -> list[type[Runtime]]:
    """The runtime classes that capture a command, preference order.

    Args:
        command (str): a command name (python3, node, ...).
    """
    return [cls for cls in RUNTIMES if command in cls.captures]


def build_runtime(name: str, **options: Any) -> Runtime:
    """Construct a runtime by name, failing loud on unknown names.

    Args:
        name (str): a runtime name from RUNTIMES.
        options (Any): constructor options for the runtime (a yaml
            entry's remaining keys, e.g. wasi's `home`).

    Raises:
        ValueError: unknown name, with a cross-language hint for
            TypeScript-only names.
    """
    cls = NAMED.get(name)
    if cls is None:
        if name in TS_ONLY_HINTS:
            raise ValueError(TS_ONLY_HINTS[name])
        known = ", ".join(repr(n) for n in NAMED)
        raise ValueError(f"unknown runtime: {name!r} (expected one of "
                         f"{known}, or {VFS_ENTRY!r})")
    return cls(**options)


def runtime_bindings_for(entries: list[Runtime | str],
                         name: str) -> dict[str, Runtime]:
    """Resolve an explicit runtime name into a binding override map.

    Naming a runtime places a line's captured stages on it without
    touching capability: only commands the runtime captures rebind,
    everything else keeps its normal binding.

    Args:
        entries (list[Runtime | str]): the workspace's ordered runtime
            world.
        name (str): the workspace runtime entry to bind to.

    Raises:
        ValueError: the name is the vfs marker or not a workspace
            entry.
    """
    if name == VFS_ENTRY:
        raise ValueError(
            "'vfs' is the default executor, not a runtime you can select")
    for entry in entries:
        if not isinstance(entry, str) and entry.name == name:
            return {command: entry for command in entry.captures}
    known = ", ".join(
        repr(e if isinstance(e, str) else e.name) for e in entries)
    raise ValueError(f"unknown runtime: {name!r} "
                     f"(workspace runtimes: {known})")


def bind_commands(entries: list[Runtime | str]) -> dict[str, Runtime]:
    """Resolve the ordered world into a command -> runtime binding map.

    A command binds to the FIRST entry that captures it; the vfs entry
    is an ordering marker with no interpreter captures. Duplicate
    names are rejected: a second entry under the same name could never
    bind anything and always signals a config mistake.

    Args:
        entries (list[Runtime | str]): runtime instances and the vfs
            marker, in precedence order.

    Raises:
        ValueError: duplicate entry names.
    """
    bindings: dict[str, Runtime] = {}
    seen: set[str] = set()
    for entry in entries:
        entry_name = entry if isinstance(entry, str) else entry.name
        if entry_name in seen:
            raise ValueError(f"duplicate runtime entry: {entry_name!r}")
        seen.add(entry_name)
        if isinstance(entry, str):
            continue
        for command in entry.captures:
            if command not in bindings:
                bindings[command] = entry
    return bindings
