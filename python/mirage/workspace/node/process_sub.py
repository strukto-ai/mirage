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

from collections.abc import Awaitable, Callable

from mirage.io.types import IOResult, materialize
from mirage.shell.errors import ExitSignal
from mirage.shell.helpers import (
    get_process_sub_body,
    get_process_sub_direction,
)
from mirage.shell.types import ProcessSubDirection, TSNodeLike
from mirage.vfs.dev.dev import DevVFS
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.mount.registry import MountRegistry


class ProcessSubError(ExitSignal):
    """A node-local refusal; carry earlier output until execute_node catches it."""

    def __init__(self) -> None:
        super().__init__(
            2, stderr=b"mirage: unsupported: process substitution >(...)\n"
        )


def process_input(
    context: EvaluationContext,
    registry: MountRegistry,
    held: list[tuple[DevVFS, str, int]],
) -> Callable[
    [TSNodeLike, Callable[[str], Awaitable[IOResult]]], Awaitable[str]
]:
    """The hook that opens a node's input process substitutions.

    Each ``<(...)`` runs as its word expands, in order with the word's
    other expansions and through the evaluator a ``$(...)`` there uses,
    and reads back as a buffered device file rather than a host pipe,
    held until the node ends; a nested node opens its own, so each lasts
    as long as the command naming it. An output ``>(...)`` is refused:
    the node naming it fails with status 2.

    Args:
        context (EvaluationContext): the evaluation the node runs in.
        registry (MountRegistry): mount registry holding ``/dev``.
        held (list[tuple[DevVFS, str, int]]): the node's open files.
    """

    async def open_input(
        node: TSNodeLike,
        execute_line: Callable[[str], Awaitable[IOResult]],
    ) -> str:
        if get_process_sub_direction(node) == ProcessSubDirection.OUTPUT:
            raise ProcessSubError
        dev, _, _ = registry.resolve("/dev/null")
        assert isinstance(dev, DevVFS)
        path, allocation = dev.allocate_input()
        held.append((dev, path, allocation))
        inner = get_process_sub_body(node)
        if inner:
            io = await execute_line(inner)
            dev.set_input(path, allocation, await materialize(io.stdout))
            context.frame.diagnostics.append(await materialize(io.stderr))
        return path

    return open_input
