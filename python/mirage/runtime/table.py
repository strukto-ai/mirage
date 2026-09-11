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
from collections.abc import Mapping, Sequence
from typing import Any, Callable

from mirage.runtime.base import Runtime
from mirage.runtime.config import RuntimeConfig
from mirage.runtime.js.quickjs import QuickJsRuntime
from mirage.runtime.mixin import LineExecutorMixin
from mirage.runtime.python.local import LocalRuntime
from mirage.runtime.python.monty import MontyRuntime
from mirage.runtime.python.sandlock import SandlockRuntime
from mirage.runtime.python.wasi import WasiRuntime
from mirage.runtime.types import RuntimeReach, ScriptSource

# One source of truth, preference order (sandboxed first, host last).
# The command -> runtime mapping is derived from each class's captures,
# never hand-maintained. `sandlock` sits between the bridged engines
# and `local`: it spawns the same host interpreter, but confined, so
# it is the milder of the two "process" reaches.
RUNTIMES: tuple[type[Runtime],
                ...] = (MontyRuntime, WasiRuntime, SandlockRuntime,
                        LocalRuntime, QuickJsRuntime)


class VFSRuntime(Runtime):
    """The workspace's built-in command engine as a routing marker.

    By default it captures nothing and serves every command no other
    runtime captures (cat, ls, echo, and anything unknown): it is the
    catch-all. Passing explicit captures flips it into an ordinary
    capturer: the workspace serves exactly those commands and anything
    unclaimed exits 126. Required: every workspace world contains
    exactly one, appended automatically when the runtimes list omits
    it; pass your own instance to customize it.

    It is a pure routing marker, so it carries no capability mixin: a
    line resolved to vfs runs on the workspace executor inline, the
    path the line takes anyway, so there is no interpreter door (run)
    and no delegate door (run_line) to implement.

    Constructed like every runtime (captures, config, script), with
    two vfs readings: captures None (the default) keeps the catch-all
    behavior, an empty sequence serves nothing (full lockdown); and
    the config has no fields today, the slot exists for uniformity.
    """

    name = "vfs"
    # A vfs-routed line runs on the workspace executor itself: it IS
    # the gate, so there is no door around it.
    reach: RuntimeReach = "vfs"
    captures: tuple[str, ...] = ()

    def __init__(
            self,
            captures: Sequence[str] | None = None,
            config: RuntimeConfig | dict[str, Any] | None = None,
            script: Callable[..., Any] | ScriptSource | None = None) -> None:
        # Declaring captures (even empty) turns the catch-all off; the
        # dispatcher reads this bit, not the tuple's length.
        self.restricted = captures is not None
        super().__init__(captures, config, script)


NAMED: dict[str, type[Runtime]] = {cls.name: cls for cls in RUNTIMES}
NAMED[VFSRuntime.name] = VFSRuntime

# Sandbox runtimes resolve on first use. Their provider SDKs are heavy
# (the daytona client alone pulls in opentelemetry), and importing them
# eagerly would put that cost on every `import mirage`, so the table
# holds module paths and imports the class only when the name is built.
SANDBOX_MODULES: dict[str, str] = {
    "daytona": "mirage.runtime.sandbox.daytona:DaytonaRuntime",
    "docker": "mirage.runtime.sandbox.docker:DockerRuntime",
    "e2b": "mirage.runtime.sandbox.e2b:E2BRuntime",
    "smolvm": "mirage.runtime.sandbox.smolvm:SmolvmRuntime",
    "ssh": "mirage.runtime.sandbox.ssh:SSHRuntime",
}

# The names mirage ships, frozen before any host registers its own, so
# `register_runtime` can refuse to shadow one the way `register_resource`
# and `register_cli_spec` refuse a builtin resource or CLI name.
BUILTIN_RUNTIMES: frozenset[str] = frozenset({*NAMED, *SANDBOX_MODULES})


def register_runtime(name: str, cls: type[Runtime]) -> None:
    """Register a host's runtime class under a config name.

    Host-side only, like ``register_resource`` and ``register_cli_spec``:
    the embedding program calls it, never a line the agent types. Once
    registered the name works everywhere a builtin's does: a ``runtimes:``
    entry in workspace YAML, a string in ``Workspace(runtimes=[...])``,
    and ``execute(runtime=name)``. Mirrors ``registerRuntime`` in
    ``runtime/table.ts``. A builtin name cannot be shadowed;
    re-registering a custom name replaces it.

    Args:
        name (str): the name config spells; also what ``build_runtime``
            resolves.
        cls (type[Runtime]): the runtime class, constructed with the
            uniform ``(captures, config, script)`` shape every runtime
            takes, which is how a yaml entry's keys reach it.

    Raises:
        ValueError: ``name`` is one mirage ships.
    """
    if name in BUILTIN_RUNTIMES:
        raise ValueError(f"cannot register {name!r}: shadows a builtin")
    NAMED[name] = cls


def known_runtimes() -> list[str]:
    """Every name ``build_runtime`` can resolve, builtin and registered."""
    return sorted({*NAMED, *SANDBOX_MODULES})


# The python engine a default world registers, named rather than left
# to a slot in DEFAULT_ENTRIES because it is the one entry the two
# implementations disagree on: Python registers monty, TypeScript
# registers pyodide (`DEFAULT_PYTHON` in runtime/table.ts), because
# `@pydantic/monty` cannot answer builtin `open()` calls yet while
# `pydantic-monty` can. Both are sandboxed; neither reaches the host.
# Pinned by integ/runtime/defaults.json, which reads the split back
# out of a default world on each host.
DEFAULT_PYTHON: str = MontyRuntime.name

# The default world when no runtimes list is given: one python engine,
# one js engine, and the builtin command engine. Defaults build
# gracefully (a missing extra leaves the command reporting its install
# hint per invocation); an explicitly listed name still fails loud.
# `local` is deliberately absent: a sandboxed default must never
# silently escalate to host execution.
DEFAULT_ENTRIES: tuple[str, ...] = (DEFAULT_PYTHON, QuickJsRuntime.name,
                                    VFSRuntime.name)

# TypeScript-only runtime names a cross-language config may carry.
TS_ONLY_HINTS: dict[str, str] = {
    "pyodide": ("runtime 'pyodide' is TypeScript-only (a WASM CPython for "
                "runtimes without a host Python); Python supports 'monty' "
                "(sandboxed, default), 'wasi' (sandboxed full CPython), "
                "'sandlock' (the host CPython, confined), 'local' (the host "
                "CPython), and 'quickjs' (sandboxed JavaScript)"),
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
    if cls is None and name in SANDBOX_MODULES:
        module_path, attr = SANDBOX_MODULES[name].split(":")
        cls = getattr(importlib.import_module(module_path), attr)
    if cls is None:
        if name in TS_ONLY_HINTS:
            raise ValueError(TS_ONLY_HINTS[name])
        known = ", ".join(repr(n) for n in known_runtimes())
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
    if name == VFSRuntime.name:
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
                       commands: Sequence[str]) -> LineExecutorMixin | None:
    """The runtime that runs this entire line, if any.

    A runtime inheriting LineExecutorMixin takes the raw line when it
    captures one of the line's commands; a "*" capture claims any
    line. A specific capture beats "*". The vfs runtime never matches
    here because it carries no mixin: the workspace executor IS the
    path a vfs-resolved line takes anyway, so there is no delegate.

    Args:
        bindings (Mapping[str, Runtime | None]): the line's resolved
            command bindings (a RouteDecision's or the registry's).
        commands (Sequence[str]): the line's stage command names.
    """
    for command in commands:
        runtime = bindings.get(command)
        if isinstance(runtime, LineExecutorMixin):
            return runtime
    star = bindings.get("*")
    if isinstance(star, LineExecutorMixin):
        return star
    return None


def catch_all(entries: list[Runtime]) -> Runtime | None:
    """The runtime that serves commands no entry captures, if any.

    That is the world's VFSRuntime, unless it declares captures (then
    it is an ordinary capturer and nothing is catch-all) or it is not
    among the given entries (refused the line / omitted).

    Args:
        entries (list[Runtime]): runtime instances to search.
    """
    for entry in entries:
        if isinstance(entry, VFSRuntime) and not entry.restricted:
            return entry
    return None
