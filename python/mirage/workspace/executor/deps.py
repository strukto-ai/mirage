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
from collections.abc import Callable
from dataclasses import dataclass, replace
from functools import partial
from typing import Any

from mirage.execution.job import JobTable
from mirage.execution.line.handle import LineHandle
from mirage.policy import HandOff
from mirage.runtime.types import DispatchFn
from mirage.shell.console import JobConsole
from mirage.workspace.executor.command.types import ExecuteNodeOpts
from mirage.workspace.expand.types import ExecuteFn
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.namespace import Namespace


@dataclass(frozen=True, slots=True)
class ExecuteNodeDeps:
    """What the node walk runs against, one value per subtree.

    A subtree's value is derived with ``dataclasses.replace``, never
    changed in place. The entry point for nested lines is stored unbound
    and bound on read to the subtree's own hand-off, event and line, so
    the hand-off a subtree's gates read and the one its nested lines run
    under are one fact.

    Args:
        dispatch (DispatchFn): VFS op dispatcher (op, path, **kw).
        registry (MountRegistry): mount registry for path resolution.
        namespace (Namespace): addressing authority for symlink ops.
        job_table (JobTable): background job management.
        entry (Callable[..., Any]): the nested-line entry point, with
            ``handed``, ``cancel`` and ``line_handle`` left unbound.
        cancel (asyncio.Event | None): event used to abort mid-flight.
        handed (HandOff | None): the hand-off this subtree runs on.
        line_handle (LineHandle | None): the line this subtree runs in;
            None makes each node a line of its own.
        sink (JobConsole | None): where the subtree writes as it runs.
    """

    dispatch: DispatchFn
    registry: MountRegistry
    namespace: Namespace
    job_table: JobTable
    entry: Callable[..., Any]
    cancel: asyncio.Event | None = None
    handed: HandOff | None = None
    line_handle: LineHandle | None = None
    sink: JobConsole | None = None

    @property
    def execute_fn(self) -> ExecuteFn:
        """The entry point bound to this subtree's hand-off, event and
        line, which every line the subtree evaluates runs through."""
        return partial(
            self.entry,
            handed=self.handed,
            cancel=self.cancel,
            line_handle=self.line_handle,
        )


def with_hand_off(
    deps: ExecuteNodeDeps, handed: HandOff | None
) -> ExecuteNodeDeps:
    """The same dependencies on another hand-off, which the gates and the
    nested lines of the subtree both read.

    Args:
        deps (ExecuteNodeDeps): the subtree's dependencies.
        handed (HandOff | None): the hand-off it runs on instead.
    """
    return replace(deps, handed=handed)


def with_opts(base: ExecuteNodeDeps, opts: ExecuteNodeOpts) -> ExecuteNodeDeps:
    """Layer a caller's overrides on the walker's dependencies.

    A key decides by its presence: ``cancel=None`` runs the subtree with
    no event, as a background job runs without its line's. A job list
    given in place of the bound one is a background job's own, as bash's
    forked job starts with none of its shell's, so a bare ``wait`` in it
    never waits on itself; the lines it runs (``eval``, ``source``, its
    EXIT action) see that list too. ``ends_shell`` and
    ``own_diagnostics`` are the walker's to read, not dependencies.

    The walk calls this at every node, so the value is built once
    whatever the number of overrides, and the walker's own is returned
    when no override differs from it.

    Args:
        base (ExecuteNodeDeps): the walker's dependencies.
        opts (ExecuteNodeOpts): the caller's overrides.

    Raises:
        TypeError: a key that names no override.
    """
    if not opts:
        return base
    if not ExecuteNodeOpts.__optional_keys__.issuperset(opts):
        unknown = min(opts.keys() - ExecuteNodeOpts.__optional_keys__)
        raise TypeError(f"execute_node: no option named {unknown!r}")
    sink = opts["sink"] if "sink" in opts else base.sink
    cancel = opts["cancel"] if "cancel" in opts else base.cancel
    line_handle = (
        opts["line_handle"] if "line_handle" in opts else base.line_handle
    )
    jobs = opts.get("job_table")
    deps = base
    if (
        jobs is not None
        or sink is not base.sink
        or cancel is not base.cancel
        or line_handle is not base.line_handle
    ):
        deps = ExecuteNodeDeps(
            base.dispatch,
            base.registry,
            base.namespace,
            base.job_table if jobs is None else jobs,
            base.entry
            if jobs is None
            else partial(base.entry, job_table=jobs),
            cancel,
            base.handed,
            line_handle,
            sink,
        )
    if "handed" in opts:
        deps = with_hand_off(deps, opts["handed"])
    return deps
