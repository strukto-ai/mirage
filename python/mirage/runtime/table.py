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

from collections.abc import Mapping, Sequence
from typing import Any, Callable

from mirage.runtime.base import Runtime, ScriptSource
from mirage.runtime.js.quickjs import QuickJsRuntime
from mirage.runtime.python.local import LocalRuntime
from mirage.runtime.python.monty import MontyRuntime
from mirage.runtime.python.wasi import WasiRuntime

# One source of truth, preference order (sandboxed first, host last).
# The command -> runtime mapping is derived from each class's captures,
# never hand-maintained.
RUNTIMES: tuple[type[Runtime], ...] = (MontyRuntime, WasiRuntime, LocalRuntime,
                                       QuickJsRuntime)


class VfsRuntime(Runtime):
    """The workspace's built-in command engine as a runtime.

    By default it captures nothing and serves every command no other
    runtime captures (cat, ls, echo, and anything unknown): it is the
    catch-all. Passing explicit captures flips it into an ordinary
    capturer: the workspace serves exactly those commands and anything
    unclaimed exits 126. Required: every workspace world contains
    exactly one, appended automatically when the runtimes list omits
    it; pass your own instance to customize it. Its run_line is the
    workspace executor itself, wired in at construction; run() stays
    unimplemented because vfs has no single-command interpreter.

    Args:
        script (Callable | ScriptSource | None): per-line admission
            script, the same contract as any runtime's script.
        captures (Sequence[str] | None): restrict the workspace to
            exactly these commands, the same field every runtime uses.
            An empty sequence serves nothing (full lockdown). None
            (the default) keeps the catch-all behavior.
    """

    name = "vfs"
    captures: tuple[str, ...] = ()
    runs_lines = True

    def __init__(self,
                 script: Callable[..., Any] | ScriptSource | None = None,
                 captures: Sequence[str] | None = None) -> None:
        self.script = script
        # Declaring captures (even empty) turns the catch-all off; the
        # dispatcher reads this bit, not the tuple's length.
        self.restricted = captures is not None
        if captures is not None:
            self.captures = tuple(captures)
        self._execute_line: Callable[..., Any] | None = None

    def bind_line_executor(self, execute: Callable[..., Any]) -> None:
        """Wire the workspace executor in as this runtime's run_line.

        Args:
            execute (Callable): async (line, stdin, env, cwd) ->
                RunResult, provided by the owning workspace.
        """
        self._execute_line = execute

    async def run(self, args: Any) -> Any:
        raise RuntimeError("the vfs runtime runs whole lines through the "
                           "workspace executor; it has no single-command "
                           "interpreter")

    async def run_line(self, line: str, stdin: bytes | None,
                       env: dict[str, str], cwd: str) -> Any:
        if self._execute_line is None:
            raise RuntimeError(
                "the vfs runtime is not attached to a workspace")
        return await self._execute_line(line, stdin, env, cwd)


NAMED: dict[str, type[Runtime]] = {cls.name: cls for cls in RUNTIMES}
NAMED[VfsRuntime.name] = VfsRuntime

# The default world when no runtimes list is given: today's behavior
# exactly. Defaults build gracefully (a missing extra leaves the
# command reporting its install hint per invocation); an explicitly
# listed name still fails loud. `local` is deliberately absent: a
# sandboxed default must never silently escalate to host execution.
DEFAULT_ENTRIES: tuple[str, ...] = ("monty", "quickjs", VfsRuntime.name)

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
        raise ValueError(f"unknown runtime: {name!r} "
                         f"(expected one of {known})")
    return cls(**options)


def runtime_bindings_for(entries: list[Runtime],
                         name: str) -> dict[str, Runtime]:
    """Resolve an explicit runtime name into a binding override map.

    Naming a runtime places a line's captured stages on it without
    touching capability: only commands the runtime captures rebind,
    everything else keeps its normal binding.

    Args:
        entries (list[Runtime]): the workspace's ordered runtime world.
        name (str): the workspace runtime entry to bind to.

    Raises:
        ValueError: the name is vfs (captures nothing, so there is
            nothing to rebind) or not a workspace entry.
    """
    if name == VfsRuntime.name:
        raise ValueError(
            "'vfs' is the default executor, not a runtime you can select")
    for entry in entries:
        if entry.name == name:
            return {command: entry for command in entry.captures}
    known = ", ".join(repr(e.name) for e in entries)
    raise ValueError(f"unknown runtime: {name!r} "
                     f"(workspace runtimes: {known})")


def bind_commands(entries: list[Runtime]) -> dict[str, Runtime]:
    """Resolve the ordered world into a command -> runtime binding map.

    A command binds to the FIRST entry that captures it; a default vfs
    runtime captures nothing, so only a vfs with declared captures
    appears in the map. Duplicate names are rejected: a second entry
    under the same name could never bind anything and always signals a
    config mistake.

    Args:
        entries (list[Runtime]): runtime instances in precedence order.

    Raises:
        ValueError: duplicate entry names.
    """
    bindings: dict[str, Runtime] = {}
    seen: set[str] = set()
    for entry in entries:
        if entry.name in seen:
            raise ValueError(f"duplicate runtime entry: {entry.name!r}")
        seen.add(entry.name)
        for command in entry.captures:
            if command not in bindings:
                bindings[command] = entry
    return bindings


def whole_line_runtime(bindings: Mapping[str, Runtime | None],
                       commands: Sequence[str]) -> Runtime | None:
    """The runtime that runs this entire line, if any.

    A runtime with ``runs_lines`` takes the raw line when it captures
    one of the line's commands; a "*" capture claims any line. A
    specific capture beats "*". The vfs runtime never matches here:
    the workspace executor IS its run_line, the path the line takes
    anyway when nothing else claims it.

    Args:
        bindings (Mapping[str, Runtime | None]): the line's resolved
            command bindings (a RoutingDecision's or the registry's).
        commands (Sequence[str]): the line's stage command names.
    """
    for command in commands:
        runtime = bindings.get(command)
        if (runtime is not None and runtime.runs_lines
                and not isinstance(runtime, VfsRuntime)):
            return runtime
    star = bindings.get("*")
    if (star is not None and star.runs_lines
            and not isinstance(star, VfsRuntime)):
        return star
    return None


def catch_all(entries: list[Runtime]) -> Runtime | None:
    """The runtime that serves commands no entry captures, if any.

    That is the world's VfsRuntime, unless it declares captures (then
    it is an ordinary capturer and nothing is catch-all) or it is not
    among the given entries (refused the line / omitted).

    Args:
        entries (list[Runtime]): runtime instances to search.
    """
    for entry in entries:
        if isinstance(entry, VfsRuntime) and not entry.restricted:
            return entry
    return None
