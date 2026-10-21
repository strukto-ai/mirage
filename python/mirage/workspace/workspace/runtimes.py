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
from typing import Any

from mirage.runtime.base import Runtime
from mirage.runtime.binding import WorkspaceBinding
from mirage.runtime.table import (
    DEFAULT_ENTRIES,
    NAMED,
    bind_commands,
    build_runtime,
)
from mirage.runtime.workspace import WorkspaceRuntime
from mirage.workspace.mount import MountRegistry


class Runtimes:
    """The workspace's ordered runtime entries.

    Owns the entry list and everything that reads or changes it:
    building it from config, adding and removing entries and closing
    them. Adding a runtime kind
    touches this module rather than the workspace.

    Args:
        registry (MountRegistry): carries the resolved bindings and the
            unavailable-runtime hints the dispatcher reports.
        binding (WorkspaceBinding): the live workspace connection shared
            by every runtime entry.
    """

    def __init__(
        self, registry: MountRegistry, binding: WorkspaceBinding
    ) -> None:
        self._registry = registry
        self._binding = binding
        self._entries: list[Runtime[Any]] = []
        self._retiring: dict[int, asyncio.Task[None]] = {}

    @property
    def entries(self) -> list[Runtime[Any]]:
        return self._entries

    def resolve(
        self, runtimes: list[Runtime[Any] | str] | None
    ) -> list[Runtime[Any]]:
        """Build and wire the ordered entries.

        Name strings become no-option instances and every instance gets
        the workspace dispatch attached. The workspace runtime is required:
        when the list omits it, an unconditional one is appended, so
        there is always an executor for unclaimed commands. An explicit
        list fails loud per entry. The default set (DEFAULT_ENTRIES)
        builds gracefully: a missing extra skips the entry so its
        commands report the install hint per invocation, never a silent
        escalation to another runtime.

        Args:
            runtimes (list[Runtime | str] | None): user entries, or
                None for the default set.
        """
        entries: list[Runtime[Any]] = []
        if runtimes is None:
            for name in DEFAULT_ENTRIES:
                try:
                    entries.append(build_runtime(name))
                except (ImportError, FileNotFoundError) as exc:
                    # The skipped class still declares its captures, so
                    # the dispatcher can answer "why is python3 dead"
                    # with the install hint instead of a blank refusal.
                    for cmd in NAMED[name].captures:
                        self._registry.runtime_unavailable.setdefault(
                            cmd, str(exc)
                        )
                    continue
        else:
            for entry in runtimes:
                entries.append(
                    build_runtime(entry) if isinstance(entry, str) else entry
                )
        if not any(entry.name == WorkspaceRuntime.name for entry in entries):
            entries.append(WorkspaceRuntime())
        bindings = bind_commands(entries)
        for entry in entries:
            entry.bind(self._binding)
        self._install(entries, bindings)
        return entries

    def add(self, runtime: Runtime[Any] | str) -> Runtime[Any]:
        """Append an entry to the ordered list.

        The entry lands last, so it never steals a command an earlier
        entry already captures (first capturer still wins). A name
        builds like a config entry and fails loud; a duplicate name is
        rejected before any state changes.

        Args:
            runtime (Runtime | str): a Runtime instance or a registry
                runtime name (built like a config entry).

        Raises:
            ValueError: unknown name or duplicate entry.
        """
        entry = build_runtime(runtime) if isinstance(runtime, str) else runtime
        candidate = [*self._entries, entry]
        bindings = bind_commands(candidate)
        entry.bind(self._binding)
        self._install(candidate, bindings)
        return entry

    async def remove(self, name: str) -> None:
        """Unbind an entry's commands now and close it once it is idle.

        Args:
            name (str): the entry's name.

        Raises:
            ValueError: the name is the workspace runtime or no entry.
        """
        if name == WorkspaceRuntime.name:
            raise ValueError(
                "cannot remove the workspace runtime: it serves every "
                "command no other runtime captures"
            )
        entry = next((e for e in self._entries if e.name == name), None)
        if entry is None:
            raise ValueError(f"no runtime entry: {name!r}")
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

    def _install(
        self, entries: list[Runtime[Any]], bindings: dict[str, Runtime[Any]]
    ) -> None:
        self._entries = entries
        self._registry.runtime_entries = entries
        self._registry.runtime_bindings = bindings


async def _retire(entry: Runtime[Any]) -> None:
    await entry.retire()
    await entry.close()
