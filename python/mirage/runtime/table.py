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
from collections.abc import Mapping
from typing import Any, TypeGuard

from mirage.machine.registry import MACHINE_MODULES
from mirage.runtime.base import Runtime
from mirage.runtime.constants import (
    EXTERNAL_COMMANDS,
    JS_GROUP,
    LANGUAGE_COMMANDS,
    PYTHON_GROUP,
    WHOLE_LINE,
)
from mirage.runtime.js.quickjs import QuickJsRuntime
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.machine import RemoteRuntime
from mirage.runtime.mixin import LineExecutorMixin, ProcessExecutorMixin
from mirage.runtime.python.local import LocalRuntime
from mirage.runtime.python.monty import MontyRuntime
from mirage.runtime.python.wasi import WasiRuntime
from mirage.runtime.sandlock import SandlockRuntime
from mirage.runtime.types import RouteDecision, RuntimeIdentity
from mirage.runtime.workspace import WorkspaceRuntime

# The builtin runtimes by name. The command -> runtime mapping is
# derived from each class's captures, never hand-maintained.
NAMED: dict[str, type[Runtime[Any]]] = {
    cls.name: cls
    for cls in (
        MontyRuntime,
        WasiRuntime,
        LocalRuntime,
        QuickJsRuntime,
        WorkspaceRuntime,
        SandlockRuntime,
        RemoteRuntime,
    )
}

# The names mirage ships, frozen before any host registers its own, so
# `register_runtime` can refuse to shadow one the way `register_vfs`
# and `register_cli_spec` refuse a builtin VFS or CLI name.
BUILTIN_RUNTIMES: frozenset[str] = frozenset(NAMED)


def register_runtime(name: str, cls: type[Runtime[Any]]) -> None:
    """Register a host's runtime class under a config name.

    Host-side only, like ``register_vfs`` and ``register_cli_spec``:
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
            uniform ``(captures, config)`` shape every runtime
            takes, which is how a yaml entry's keys reach it.

    Raises:
        ValueError: ``name`` is one mirage ships.
    """
    if name in BUILTIN_RUNTIMES:
        raise ValueError(f"cannot register {name!r}: shadows a builtin")
    NAMED[name] = cls


def known_runtimes() -> list[str]:
    """Every name ``build_runtime`` can resolve, builtin and registered."""
    return sorted(NAMED)


# The default world when no runtimes list is given: the builtin command
# engine alone, as TypeScript's, so an interpreter runs only where the
# config names one (integ/runtime/routing/defaults.json pins it).
DEFAULT_ENTRIES: tuple[str, ...] = (WorkspaceRuntime.name,)

# TypeScript-only runtime names a cross-language config may carry.
RUNTIME_HINTS: dict[str, str] = {
    "pyodide": (
        "runtime 'pyodide' is TypeScript-only (a WASM CPython for "
        "runtimes without a host Python); Python supports 'monty' "
        "(sandboxed), 'wasi' (sandboxed full CPython), "
        "'sandlock' (confined native processes), 'local' (the host "
        "CPython), and 'quickjs' (sandboxed JavaScript)"
    ),
}


# By identity, the name each runtime built with no options came from.
_BUILT_FROM: dict[int, tuple[weakref.ref[Runtime[Any]], str]] = {}


def build_runtime(name: str, **options: Any) -> Runtime[Any]:
    """Construct a runtime by name, failing loud on unknown names.

    Args:
        name (str): a runtime name from NAMED.
        options (Any): constructor options for the runtime (a yaml
            entry's remaining keys, e.g. wasi's `home`).

    Raises:
        ValueError: unknown name, with a cross-language hint for
            TypeScript-only names.
    """
    runtime = runtime_class(name)(**options)
    if not options:
        key = id(runtime)

        def forget(_gone: weakref.ref[Runtime[Any]]) -> None:
            _BUILT_FROM.pop(key, None)

        _BUILT_FROM[key] = (weakref.ref(runtime, forget), name)
    return runtime


def built_from(runtime: Runtime[Any]) -> str | None:
    """The registry name a runtime was built from with no options.

    Args:
        runtime (Runtime): a runtime entry.

    Returns:
        str | None: the name, or None for one built with options or by
        the host.
    """
    held = _BUILT_FROM.get(id(runtime))
    return held[1] if held is not None and held[0]() is runtime else None


def runtime_class(name: str) -> type[Runtime[Any]]:
    """The runtime class a name resolves to.

    Args:
        name (str): a runtime name from NAMED.

    Raises:
        ValueError: unknown name, with a hint for TypeScript-only names
            and for machine providers.
    """
    cls = NAMED.get(name)
    if cls is None:
        if name in RUNTIME_HINTS:
            raise ValueError(RUNTIME_HINTS[name])
        if name in MACHINE_MODULES:
            raise ValueError(
                f"{name!r} is a machine provider, not a runtime: declare the"
                f" machine under machines: with provider: {name}, and run"
                " its programs with the remote runtime"
            )
        known = ", ".join(repr(n) for n in known_runtimes())
        raise ValueError(
            f"unknown runtime: {name!r} (expected one of {known})"
        )
    return cls


def runtime_bindings_for(
    entries: list[Runtime[Any]], name: str
) -> dict[str, Runtime[Any]]:
    """Resolve an explicit runtime name into a binding override map.

    Naming a runtime places a line's captured stages on it without
    touching capability: only commands the runtime captures rebind,
    everything else keeps its normal binding.

    Args:
        entries (list[Runtime]): the workspace's ordered runtime world.
        name (str): the workspace runtime entry to bind to.

    Raises:
        ValueError: the name is workspace (captures nothing, so there is
            nothing to rebind) or not a workspace entry.
    """
    if name == WorkspaceRuntime.name:
        raise ValueError(
            "'workspace' is the default executor, not a runtime you can select"
        )
    for entry in entries:
        if entry.name == name:
            return {command: entry for command in entry.captures}
    known = ", ".join(repr(e.name) for e in entries)
    raise ValueError(
        f"unknown runtime: {name!r} (workspace runtimes: {known})"
    )


def bind_commands(entries: list[Runtime[Any]]) -> dict[str, Runtime[Any]]:
    """Resolve the ordered world into a command -> runtime binding map.

    A command binds to the FIRST entry that captures it; a default workspace
    runtime captures nothing, so only a workspace entry with declared captures
    appears in the map. Duplicate names are rejected: a second entry
    under the same name could never bind anything and always signals a
    config mistake.

    Args:
        entries (list[Runtime]): runtime instances in precedence order.

    Raises:
        ValueError: a capture that is not a program or a group, ``@line``
            or ``@external`` on a runtime that cannot run a line or a
            process, a name a language-only runtime does not run, or
            duplicate entry names.
    """
    bindings: dict[str, Runtime[Any]] = {}
    seen: set[str] = set()
    for entry in entries:
        for capture in entry.captures:
            if capture not in (EXTERNAL_COMMANDS, WHOLE_LINE) and (
                capture == "*" or capture.startswith("@")
            ):
                raise ValueError(
                    f"{capture!r} is not a program or a group; the groups"
                    f" are {EXTERNAL_COMMANDS!r}, {WHOLE_LINE!r},"
                    f" {PYTHON_GROUP!r} and {JS_GROUP!r}"
                )
        if WHOLE_LINE in entry.captures and not isinstance(
            entry, LineExecutorMixin
        ):
            raise ValueError(f"{WHOLE_LINE} requires shell execution")
        if EXTERNAL_COMMANDS in entry.captures and not isinstance(
            entry, (LineExecutorMixin, ProcessExecutorMixin)
        ):
            raise ValueError("@external requires process or shell execution")
        if isinstance(entry, LanguageRuntime) and not isinstance(
            entry, (LineExecutorMixin, ProcessExecutorMixin)
        ):
            for capture in entry.captures:
                if capture not in LANGUAGE_COMMANDS[entry.language]:
                    raise ValueError(
                        f"runtime {entry.name!r} does not run {capture!r}"
                    )
        if entry.name in seen:
            raise ValueError(f"duplicate runtime entry: {entry.name!r}")
        seen.add(entry.name)
        for command in entry.captures:
            if command not in bindings:
                bindings[command] = entry
    return bindings


def shadowed_captures(
    entries: list[Runtime[Any]],
) -> list[tuple[str, str, str]]:
    """Each capture an earlier entry already takes, as (capture,
    winner, shadowed), in list order.

    Args:
        entries (list[Runtime]): runtime instances in precedence order.
    """
    winners: dict[str, str] = {}
    shadowed: list[tuple[str, str, str]] = []
    for entry in entries:
        for capture in dict.fromkeys(entry.captures):
            if capture in winners:
                shadowed.append((capture, winners[capture], entry.name))
            else:
                winners[capture] = entry.name
    return shadowed


def whole_line_runtime(
    bindings: Mapping[str, RuntimeIdentity | None],
) -> LineExecutorMixin[Any] | None:
    """The runtime that runs this entire line, if any.

    Only an explicit WHOLE_LINE capture claims a whole line. Named captures
    and EXTERNAL_COMMANDS execute individual commands. The workspace
    runtime never matches here because it carries no mixin: the
    workspace executor IS the path a workspace-resolved line takes
    anyway, so there is no delegate.

    Args:
        bindings (Mapping[str, Runtime | None]): the line's resolved
            command bindings (a RouteDecision's or the registry's).
    """
    whole = bindings.get(WHOLE_LINE)
    if isinstance(whole, LineExecutorMixin):
        return whole
    return None


def is_sandbox(entry: RuntimeIdentity | None) -> TypeGuard[Runtime[Any]]:
    """Whether a runtime is a sandbox: a line executor on another
    machine.

    Args:
        entry (RuntimeIdentity | None): the runtime, None for none.
    """
    return (
        isinstance(entry, Runtime)
        and isinstance(entry, LineExecutorMixin)
        and entry.reach == "remote"
    )


def routed(
    entries: list[Runtime[Any]],
    bindings: Mapping[str, RuntimeIdentity | None],
    runtime: str | None,
    machine: str | None,
) -> RouteDecision[RuntimeIdentity]:
    """The decision a policy's route places a line or a command on.

    ``workspace`` keeps it in Mirage: no line executor (an ``@line``
    capture) takes it, and each command stays on its first other
    capturer. Any other runtime serves every command it captures over
    ``bindings``; none leaves each command where ``bindings`` put it.

    Args:
        entries (list[Runtime]): the workspace's ordered runtimes.
        bindings (Mapping[str, RuntimeIdentity | None]): the bindings
            the route overlays: the static ones for a line, the line's
            own for a command.
        runtime (str | None): the runtime the route names.
        machine (str | None): the machine it names.

    Raises:
        ValueError: no entry has the runtime's name.
    """
    placed: dict[str, RuntimeIdentity | None] = dict(bindings)
    if runtime == WorkspaceRuntime.name:
        kept = [e for e in entries if WHOLE_LINE not in e.captures]
        placed = {
            command: None for entry in entries for command in entry.captures
        }
        placed.update(bind_commands(kept))
    elif runtime is not None:
        placed.update(runtime_bindings_for(entries, runtime))
    return RouteDecision(
        bindings=placed, fallback=catch_all(entries), machine=machine
    )


def catch_all(entries: list[Runtime[Any]]) -> Runtime[Any] | None:
    """The runtime that serves commands no entry captures, if any.

    That is the world's WorkspaceRuntime, unless it declares captures (then
    it is an ordinary capturer and nothing is catch-all) or it is not
    among the given entries.

    Args:
        entries (list[Runtime]): runtime instances to search.
    """
    for entry in entries:
        if isinstance(entry, WorkspaceRuntime) and not entry.restricted:
            return entry
    return None
