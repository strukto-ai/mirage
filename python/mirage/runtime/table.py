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

from typing import Any

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
