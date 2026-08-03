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

from collections.abc import Callable, Mapping
from typing import Any

from mirage.runtime.base import Runtime
from mirage.runtime.policy import PolicyDecision, parsed_commands
from mirage.runtime.table import (DEFAULT_ENTRIES, NAMED, VfsRuntime,
                                  bind_commands, build_runtime,
                                  whole_line_runtime)
from mirage.workspace.mount import MountRegistry
from mirage.workspace.types import DispatchFn
from mirage.workspace.workspace.guard import reject_config_script

PrefixFn = Callable[[], list[str]]


class Runtimes:
    """The workspace's ordered runtime entries.

    Owns the entry list and everything that reads it: building it from
    config, appending to it, and answering which entry takes a whole
    line. Adding a runtime kind touches this module rather than the
    workspace.

    Args:
        registry (MountRegistry): carries the resolved bindings and the
            unavailable-runtime hints the dispatcher reports.
        dispatch (DispatchFn): the workspace op dispatch each entry is
            attached to.
        mount_prefixes (PrefixFn): pull-model provider read per run, so
            mounts added after construction are picked up.
    """

    def __init__(self, registry: MountRegistry, dispatch: DispatchFn,
                 mount_prefixes: PrefixFn) -> None:
        self._registry = registry
        self._dispatch = dispatch
        self._mount_prefixes = mount_prefixes
        self._entries: list[Runtime] = []

    @property
    def entries(self) -> list[Runtime]:
        return self._entries

    def resolve(self, runtimes: list[Runtime | str] | None) -> list[Runtime]:
        """Build and wire the ordered entries.

        Name strings become no-option instances and every instance gets
        the workspace dispatch attached. The vfs runtime is required:
        when the list omits it, an unconditional one is appended, so
        there is always an executor for unclaimed commands. An explicit
        list fails loud per entry. The default set (monty, quickjs,
        vfs) builds gracefully: a missing extra skips the entry so its
        commands report the install hint per invocation, never a silent
        escalation to another runtime.

        Args:
            runtimes (list[Runtime | str] | None): user entries, or
                None for the default set.
        """
        entries: list[Runtime] = []
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
                            cmd, str(exc))
                    continue
        else:
            for entry in runtimes:
                entries.append(
                    build_runtime(entry) if isinstance(entry, str) else entry)
        if not any(entry.name == VfsRuntime.name for entry in entries):
            entries.append(VfsRuntime())
        for entry in entries:
            reject_config_script(f"runtime {entry.name!r} script",
                                 entry.script)
            entry.attach(self._dispatch, self._mount_prefixes)
        self._entries = entries
        return entries

    def add(self, runtime: Runtime | str) -> Runtime:
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
        entry = (build_runtime(runtime)
                 if isinstance(runtime, str) else runtime)
        reject_config_script(f"runtime {entry.name!r} script", entry.script)
        candidate = [*self._entries, entry]
        bindings = bind_commands(candidate)
        entry.attach(self._dispatch, self._mount_prefixes)
        self._entries = candidate
        self._registry.runtime_bindings = bindings
        return entry

    def whole_line(self, ast: Any,
                   decision: PolicyDecision | None) -> Runtime | None:
        """The entry taking this whole line, None for the executor.

        An entry with ``runs_lines`` takes the raw line when the line's
        resolved bindings place one of its commands (or "*") on it;
        everything else walks the executor's tree. The common set has
        no such entry, so this is a cheap scan.

        Args:
            ast: the parsed tree-sitter root node.
            decision (PolicyDecision | None): the line's decision,
                None when only static bindings apply.
        """
        if not any(entry.runs_lines and not isinstance(entry, VfsRuntime)
                   for entry in self._entries):
            return None
        bindings: Mapping[str, Runtime
                          | None] = (decision.bindings if decision is not None
                                     else self._registry.runtime_bindings)
        commands = parsed_commands(ast, self._registry.clis.names())
        return whole_line_runtime(bindings, [c.command for c in commands])
