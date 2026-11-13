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

import asyncio
import logging
from typing import Any

from mirage.execution.machine.table import MachineTable
from mirage.runtime.base import Runtime
from mirage.runtime.binding import WorkspaceBinding
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.machine import RemoteRuntime
from mirage.runtime.table import (
    MachineSpec,
    bind_commands,
    build_entry,
    built_from,
    is_sandbox,
    shadowed_captures,
)
from mirage.runtime.workspace import WorkspaceRuntime
from mirage.workspace.mount import MountRegistry

logger = logging.getLogger(__name__)


class Runtimes:
    """The engine each of the workspace's machines runs, in capture order.

    Owns the entry list and everything that reads or changes it:
    wiring it, adding and removing machines and closing them. Adding an
    engine kind touches this module rather than the workspace.

    Args:
        registry (MountRegistry): carries the resolved bindings and the
            unavailable-runtime hints the dispatcher reports.
        binding (WorkspaceBinding): the live workspace connection shared
            by every runtime entry.
        machines (MachineTable): the machines a machine entry runs on.
    """

    def __init__(
        self,
        registry: MountRegistry,
        binding: WorkspaceBinding,
        machines: MachineTable,
    ) -> None:
        self._registry = registry
        self._binding = binding
        self._machines = machines
        self._entries: list[Runtime[Any]] = []
        self._retiring: dict[int, asyncio.Task[None]] = {}

    @property
    def machines(self) -> MachineTable:
        """The machines a machine entry runs its programs on."""
        return self._machines

    @property
    def entries(self) -> list[Runtime[Any]]:
        return self._entries

    def specs(self) -> dict[str, dict[str, Any]]:
        """The ``machines:`` entries of the engines built from one, by
        name, in list order. A copy rebuilds these; a machine provider's
        runtime and an engine the host built stay behind.
        """
        return {
            entry.name: spec
            for entry in self._entries
            if (spec := built_from(entry)) is not None
        }

    def resolve(self, entries: list[Runtime[Any]]) -> list[Runtime[Any]]:
        """Wire the ordered entries.

        Every entry gets the workspace dispatch attached. The shell is
        required: when the list omits it, an unconditional one is
        appended, so there is always an executor for unclaimed commands.

        Args:
            entries (list[Runtime]): the engine of each machine, in
                capture order.
        """
        entries = list(entries)
        if not any(entry.name == WorkspaceRuntime.name for entry in entries):
            entries.append(WorkspaceRuntime())
        bindings = bind_commands(entries)
        for entry in entries:
            self._bind(entry)
        self._install(entries, bindings)
        return entries

    def add(self, name: str, spec: MachineSpec) -> Runtime[Any]:
        """Add a machine's engine to the ordered list.

        A sandbox (``is_sandbox``) lands after the last sandbox listed,
        else before the first language runtime, else last; any other
        entry lands last. A duplicate name is rejected before any state
        changes.

        Args:
            name (str): the machine's name.
            spec (MachineSpec): an engine, or the entry as YAML spells
                it; a machine provider's handle is the workspace's to
                hold from the start.

        Raises:
            ValueError: what ``build_entry`` refuses, a machine provider,
                or a duplicate name.
        """
        handle, entry = build_entry(name, spec)
        if handle is not None:
            raise ValueError(
                f"machine {name!r}: a {handle.provider} machine is declared"
                " when the workspace is built"
            )
        at = len(self._entries)
        if is_sandbox(entry):
            sandboxes = [
                i + 1 for i, e in enumerate(self._entries) if is_sandbox(e)
            ]
            languages = [
                i
                for i, e in enumerate(self._entries)
                if isinstance(e, LanguageRuntime)
            ]
            if sandboxes:
                at = sandboxes[-1]
            elif languages:
                at = languages[0]
        candidate = [*self._entries[:at], entry, *self._entries[at:]]
        bindings = bind_commands(candidate)
        self._bind(entry)
        self._install(candidate, bindings)
        return entry

    async def remove(self, name: str) -> None:
        """Unbind an entry's commands now and close it once it is idle.

        Args:
            name (str): the machine's name.

        Raises:
            ValueError: the name is the shell's or no machine's.
        """
        if name == WorkspaceRuntime.name:
            raise ValueError(
                "cannot remove the workspace machine: it serves every "
                "command no other machine captures"
            )
        entry = next((e for e in self._entries if e.name == name), None)
        if entry is None:
            raise ValueError(f"no machine: {name!r}")
        remaining = [e for e in self._entries if e is not entry]
        self._install(remaining, bind_commands(remaining))
        identity = id(entry)
        closing = asyncio.create_task(_retire(entry))
        self._retiring[identity] = closing
        try:
            await asyncio.shield(closing)
        finally:
            if closing.done():
                self._retiring.pop(identity, None)

    async def close(self) -> None:
        """Close every entry, including the ones still being removed."""
        results = await asyncio.gather(
            *(entry.close() for entry in self._entries),
            *(asyncio.shield(task) for task in self._retiring.values()),
            return_exceptions=True,
        )
        failures = [r for r in results if isinstance(r, BaseException)]
        if failures:
            raise (
                failures[0]
                if len(failures) == 1
                else BaseExceptionGroup("runtime close failed", failures)
            )

    def _bind(self, entry: Runtime[Any]) -> None:
        """Bind an entry to the workspace, and a machine one to its
        machines once the workspace has it, so an entry another
        workspace holds keeps its own.

        Args:
            entry (Runtime): the entry.

        Raises:
            ValueError: a machine entry's machine is not the workspace's,
                or another workspace holds the entry.
        """
        if isinstance(entry, RemoteRuntime):
            self._machines.get(entry.default_machine)
        entry.bind(self._binding)
        if isinstance(entry, RemoteRuntime):
            entry.bind_machines(self._machines)

    def _install(
        self, entries: list[Runtime[Any]], bindings: dict[str, Runtime[Any]]
    ) -> None:
        routed = self._registry.policies.has_placement()
        for capture, winner, shadowed in (
            [] if routed else shadowed_captures(entries)
        ):
            logger.warning(
                "machine %r runs %r only when a route names it: %r, "
                "listed before it, takes it",
                shadowed,
                capture,
                winner,
            )
        self._entries = entries
        self._registry.runtime_entries = entries
        self._registry.runtime_bindings = bindings


async def _retire(entry: Runtime[Any]) -> None:
    await entry.retire()
    await entry.close()
