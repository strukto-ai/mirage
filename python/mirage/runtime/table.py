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
from collections.abc import Mapping, Sequence
from typing import Any, TypeAlias, TypeGuard

from mirage.machine.handle import MachineHandle
from mirage.machine.registry import build_machine
from mirage.runtime.base import Runtime
from mirage.runtime.constants import (
    EXTERNAL_COMMANDS,
    HOST,
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
from mirage.utils.loader import load_attr

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
    registered the name is a ``runtime`` an ``in_process`` machine
    entry may name. Mirrors ``registerRuntime`` in ``runtime/table.ts``.
    A builtin name cannot be shadowed; re-registering a custom name
    replaces it.

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


# TypeScript-only engine names a cross-language config may carry.
RUNTIME_HINTS: dict[str, str] = {
    "pyodide": (
        "runtime 'pyodide' is TypeScript-only (a WASM CPython for "
        "hosts without a Python); Python runs 'quickjs' and 'wasi' in "
        "process and 'monty' on a worker"
    ),
}

# The providers a ``machines:`` entry names for an engine of Mirage's
# own rather than a machine it reaches: in its process, in worker
# processes it spawns, or as native programs on its host.
IN_PROCESS = "in_process"
WORKER = "worker"
ENGINE_PROVIDERS: tuple[str, ...] = (IN_PROCESS, WORKER, HOST)

# The runtimes a builtin provider runs no other way.
_PLACED: dict[str, str] = {
    MontyRuntime.name: WORKER,
    LocalRuntime.name: HOST,
    SandlockRuntime.name: HOST,
    RemoteRuntime.name: "a machine provider",
    WorkspaceRuntime.name: IN_PROCESS,
}

# What a ``machines:`` entry may be: a machine handle, an engine
# instance, or the entry as YAML spells it.
MachineSpec: TypeAlias = MachineHandle | Runtime[Any] | Mapping[str, Any]

# A workspace's ``machines``: the entries by name, or handles and
# engines named by their own ``name``.
MachineSpecs: TypeAlias = (
    Mapping[str, MachineSpec] | Sequence[MachineHandle | Runtime[Any]]
)


def build_entry(
    name: str, spec: MachineSpec
) -> tuple[MachineHandle | None, Runtime[Any]]:
    """The machine one ``machines:`` entry describes, and the engine
    that runs what it captures there.

    A machine provider (docker, ssh, ...) builds its handle and the
    remote runtime that runs its ``captures`` through it. An engine
    provider builds the engine alone: ``in_process`` the one its
    ``runtime`` names (none for the shell, which only ``workspace`` may
    be), ``worker`` monty, ``host`` the host's own programs, confined by
    sandlock when a ``sandbox`` block grants paths. The entry's other
    keys are the engine's config.

    Args:
        name (str): the entry's name, which the engine takes.
        spec (MachineSpec): a handle, an engine, or the entry as YAML
            spells it.

    Raises:
        ValueError: ``workspace`` for anything but the shell, an engine
            its provider does not run, a ``sandbox`` that is not a
            mapping, or what ``build_machine`` refuses.
    """
    if isinstance(spec, Runtime):
        runtime = spec
    elif isinstance(spec, MachineHandle) or spec.get("provider") not in (
        ENGINE_PROVIDERS
    ):
        handle = build_machine(name, spec)
        runtime = RemoteRuntime(name, handle.config.captures)
        if name == WorkspaceRuntime.name:
            raise ValueError(f"{name!r} is the shell's machine name")
        return handle, runtime
    else:
        fields = dict(spec)
        provider = fields.pop("provider")
        captures = fields.pop("captures", None)
        sandbox = fields.pop("sandbox", None)
        if "sandbox" in spec and not isinstance(sandbox, Mapping):
            raise ValueError(f"machine {name!r}: sandbox must be a mapping")
        cls = _runtime_for(
            name, provider, fields.pop("runtime", None), sandbox
        )
        config = {**fields, **(sandbox or {})}
        runtime = cls(captures=captures, config=config or None)
        key = id(runtime)

        def forget(_gone: weakref.ref[Runtime[Any]]) -> None:
            _BUILT_FROM.pop(key, None)

        _BUILT_FROM[key] = (weakref.ref(runtime, forget), dict(spec))
    if (name == WorkspaceRuntime.name) != isinstance(
        runtime, WorkspaceRuntime
    ):
        raise ValueError(f"{name!r} is the shell's machine name")
    runtime.name = name
    return None, runtime


def _runtime_for(
    name: str,
    provider: str,
    runtime: str | type[Runtime[Any]] | None,
    sandbox: Mapping[str, Any] | None,
) -> type[Runtime[Any]]:
    """The runtime an engine provider's entry runs.

    Args:
        name (str): the entry's name, for the message.
        provider (str): ``in_process``, ``worker`` or ``host``.
        runtime (str | type[Runtime] | None): the entry's ``runtime``: a
            registered name, a ``source:Class`` reference, or the class.
        sandbox (Mapping[str, Any] | None): the entry's ``sandbox``.

    Raises:
        ValueError: a runtime the provider does not run, a sandbox off
            a host, or a name ``runtime_class`` does not know.
    """
    if sandbox is not None and provider != HOST:
        raise ValueError(f"machine {name!r}: only a host takes a sandbox")
    if provider == HOST:
        if runtime is not None:
            raise ValueError(
                f"machine {name!r}: a host runs its own programs, not a runtime"
            )
        return SandlockRuntime if sandbox is not None else LocalRuntime
    if provider == WORKER:
        if runtime not in (None, MontyRuntime.name):
            raise ValueError(
                f"machine {name!r}: a worker runs {MontyRuntime.name!r},"
                f" not {runtime!r}"
            )
        return MontyRuntime
    if runtime is None:
        return WorkspaceRuntime
    if isinstance(runtime, type):
        if not issubclass(runtime, Runtime):
            raise ValueError(
                f"machine {name!r}: its runtime is not a Runtime subclass"
            )
        return runtime
    if ":" in runtime:
        loaded = load_attr(runtime)
        if not (isinstance(loaded, type) and issubclass(loaded, Runtime)):
            raise ValueError(f"{runtime!r} is not a Runtime subclass")
        return loaded
    if runtime in _PLACED:
        raise ValueError(
            f"machine {name!r}: {runtime!r} runs on {_PLACED[runtime]},"
            f" not {IN_PROCESS}"
        )
    return runtime_class(runtime)


def in_process_runtimes() -> list[str]:
    """Every runtime an ``in_process`` machine may name."""
    return [name for name in known_runtimes() if name not in _PLACED]


def split_machines(
    machines: MachineSpecs | None,
) -> tuple[dict[str, MachineHandle], list[Runtime[Any]]]:
    """The machine handles and the ordered engine entries ``machines``
    describes, each entry named for its machine.

    Args:
        machines (MachineSpecs | None): the entries by name, or handles
            and engines named by their own ``name``; None for none.

    Raises:
        ValueError: what ``build_entry`` refuses.
    """
    items = (
        list(machines.items())
        if isinstance(machines, Mapping)
        else [(spec.name, spec) for spec in machines or ()]
    )
    handles: dict[str, MachineHandle] = {}
    entries: list[Runtime[Any]] = []
    for name, spec in items:
        handle, runtime = build_entry(name, spec)
        if handle is not None:
            handles[name] = handle
        entries.append(runtime)
    return handles, entries


# By identity, the ``machines:`` entry each engine provider's engine was
# built from, which a copy of the workspace builds again.
_BUILT_FROM: dict[int, tuple[weakref.ref[Runtime[Any]], dict[str, Any]]] = {}


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
    return runtime_class(name)(**options)


def built_from(runtime: Runtime[Any]) -> dict[str, Any] | None:
    """The ``machines:`` entry an engine provider's engine was built from.

    Args:
        runtime (Runtime): a workspace entry.

    Returns:
        dict[str, Any] | None: the entry, or None for a machine
        provider's runtime or an engine the host built.
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
        known = ", ".join(repr(n) for n in known_runtimes())
        raise ValueError(
            f"unknown runtime: {name!r} (expected one of {known})"
        )
    return cls


def machine_bindings_for(
    entries: list[Runtime[Any]], name: str
) -> dict[str, Runtime[Any]]:
    """Resolve a machine a line names into a binding override map.

    Naming a machine places a line's captured stages on it without
    touching capability: only commands its entry captures rebind,
    everything else keeps its normal binding.

    Args:
        entries (list[Runtime]): the workspace's ordered entries.
        name (str): the machine.

    Raises:
        ValueError: the name is ``workspace`` (the shell captures
            nothing, so there is nothing to rebind) or no machine.
    """
    if name == WorkspaceRuntime.name:
        raise ValueError(
            "'workspace' is the default executor, not a machine you can select"
        )
    found = next((e for e in entries if e.name == name), None)
    if found is not None:
        return {command: found for command in found.captures}
    known = ", ".join(
        repr(e.name) for e in entries if e.name != WorkspaceRuntime.name
    )
    raise ValueError(
        f"unknown machine: {name!r} (workspace machines: {known or 'none'})"
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
                        f"machine {entry.name!r} does not run {capture!r}"
                    )
        if entry.name in seen:
            raise ValueError(f"duplicate machine: {entry.name!r}")
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
    machine: str | None,
) -> RouteDecision[RuntimeIdentity]:
    """The decision a policy's route places a line or a command on.

    ``workspace`` keeps it in Mirage: no line executor (an ``@line``
    capture) takes it, and each command stays on its first other
    capturer. Any other machine serves every command it captures over
    ``bindings``; none leaves each command where ``bindings`` put it.

    Args:
        entries (list[Runtime]): the workspace's ordered entries.
        bindings (Mapping[str, RuntimeIdentity | None]): the bindings
            the route overlays: the static ones for a line, the line's
            own for a command.
        machine (str | None): the machine the route names.

    Raises:
        ValueError: no entry is the machine.
    """
    placed: dict[str, RuntimeIdentity | None] = dict(bindings)
    if machine == WorkspaceRuntime.name:
        kept = [e for e in entries if WHOLE_LINE not in e.captures]
        placed = {
            command: None for entry in entries for command in entry.captures
        }
        placed.update(bind_commands(kept))
    elif machine is not None:
        placed.update(machine_bindings_for(entries, machine))
    return RouteDecision(bindings=placed, fallback=catch_all(entries))


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
