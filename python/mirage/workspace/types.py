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

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from mirage.io.types import IOResult
from mirage.observe.record import OpRecord
from mirage.types import Limit, MountMode, PathSpec

# Runs one text line in a session (`execute_fn(line, session_id=...)`):
# what `eval`, `source`, `xargs` and find's `-exec` hand their inner
# line to.
ExecuteLine = Callable[..., Awaitable[IOResult]]


@dataclass
class MountRow:
    """What the ``Files`` facade knows about one mount.

    Args:
        prefix (str): the mount prefix.
        resource_type (str): the VFS name, recorded on each op.
        mode (MountMode): the mount's access mode.
        sizes_always_known (bool): mirrors ``BaseVFS.sizes_always_known``;
            read by the fskit mount guard, which cannot serve a VFS that
            sizes files only on read.
        anchor (bool): the scratch root the workspace adds when no mount
            claims ``/``, which nobody mounted.
        visible (Callable[[str | None], bool] | None): whether the
            session a call through a facade of the given session id runs
            as (None: the default facade) is told of the mount at all,
            None for always (a session's own documents mount answers it).
        searchable (tuple[str, ...] | None): the mount VFS's
            ``searchable`` globs, the files its ``files_containing``
            answers for; None for every file.
        walk_limit (int): the mount VFS's ``walk_limit``, -1
            for no cap.
        command_limits (Mapping[str, Limit]): the mount's own command
            limits.
        workspace_limits (Mapping[str, Limit]): the workspace's, which
            a command's walk resolves through beside the mount's.
        calls (frozenset[str]): the functions the mount's VFS answers
            itself: each dispatcher call it defines, and ``read_range``
            when its reads fetch only the range asked for.
    """

    prefix: str
    resource_type: str
    mode: MountMode
    sizes_always_known: bool = False
    anchor: bool = False
    visible: Callable[[str | None], bool] | None = None
    searchable: tuple[str, ...] | None = None
    walk_limit: int = -1
    command_limits: Mapping[str, Limit] = field(default_factory=dict)
    workspace_limits: Mapping[str, Limit] = field(default_factory=dict)
    calls: frozenset[str] = frozenset()

    @property
    def default_limit(self) -> Limit:
        """The bottom layer of a command's limit here: the mount's
        ``walk_limit``."""
        return Limit(walk_limit=self.walk_limit)


@dataclass
class ExecutionNode:
    """A node in the execution tree capturing per-command stderr and exit code.

    Args:
        command (str | None): Leaf command string, None for operators.
        op (str | None): Operator ("|", ";", "&&", "||"), None for leaf nodes.
        stderr (bytes): This node's stderr output.
        exit_code (int): This node's exit code.
        children (list[ExecutionNode]): Child nodes (empty for leaf commands).
        records (list[OpRecord]): I/O operation records for this node.
        paths (list[PathSpec]): Classified path operands of a leaf mount
            command. Transient (not serialized): lets the lazy-stream drain
            respell filesystem errors as typed, like the eager chokepoint.
        refused (bool): The admission gate refused the line, so it never
            ran. Transient: the redirect layer reads it to leave output
            targets untouched, where an ordinary failure still creates
            and truncates them as bash's open-before-exec would.
        unopened (bool): A redirect target could not be opened, so the
            command never ran. Transient: the ERR action answers a group
            or loop that fails this way, which its own commands would
            have answered otherwise.
    """

    command: str | None = None
    op: str | None = None
    stderr: bytes = b""
    exit_code: int = 0
    children: list["ExecutionNode"] = field(default_factory=list)
    records: list[OpRecord] = field(default_factory=list)
    paths: list[PathSpec] = field(default_factory=list)
    refused: bool = False
    unopened: bool = False

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {}
        if self.command is not None:
            d["command"] = self.command
        if self.op is not None:
            d["op"] = self.op
        d["stderr"] = self.stderr.decode(errors="replace")
        d["exit_code"] = self.exit_code
        if self.children:
            d["children"] = [c.to_dict() for c in self.children]
        if self.records:
            d["records"] = [r.to_dict() for r in self.records]
        return d


class StatusWriter:
    """Opaque per-line identity for status writes.

    Minted once per ``Workspace.shell`` and carried on the line's
    ``LineFrame``, so ``record_status`` can say whose ``$?`` the session
    is holding and a cancelled line puts back only what it overwrote.
    """

    __slots__ = ()
