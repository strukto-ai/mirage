from collections.abc import Awaitable, Callable, Sequence
from typing import TypeVar

from mirage.io.types import ByteSource, IOResult, materialize
from mirage.runtime.routing import RouteDecision
from mirage.shell.bytes import encode_text
from mirage.shell.call_stack import CallStack
from mirage.shell.errors import ExitSignal
from mirage.shell.helpers import (
    get_process_sub_body,
    get_process_sub_direction,
)
from mirage.shell.literal import LiteralNode
from mirage.shell.types import NodeType as NT
from mirage.shell.types import ProcessSubDirection, TSNodeLike
from mirage.vfs.dev.dev import DevVFS
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.expand.argv import Argv, expand_argv
from mirage.workspace.expand.node import child_line
from mirage.workspace.mount.namespace.namespace import Namespace
from mirage.workspace.mount.registry import MountRegistry
from mirage.workspace.session.state import session_view

T = TypeVar("T")


async def own_words(node: TSNodeLike, pending: Awaitable[T]) -> T:
    """Await an expansion of the command's own words; an ``ExitSignal``
    it raises names the command, whose redirects bash had not applied.

    Args:
        node (TSNodeLike): the command.
        pending (Awaitable[T]): the expansion.
    """
    try:
        return await pending
    except ExitSignal as exc:
        exc.expanding = node.id
        raise


class CommandPreparation:
    """Own command-word expansion and its temporary process-substitution operands."""

    def __init__(self) -> None:
        self.dev: DevVFS | None = None
        self.inputs: list[tuple[str, int]] = []
        self.diagnostics: list[bytes] = []

    async def expand(
        self,
        node: TSNodeLike,
        parts: Sequence[TSNodeLike],
        context: EvaluationContext,
        execute_fn: Callable[..., Awaitable[IOResult]],
        call_stack: CallStack | None,
        registry: MountRegistry,
        namespace: Namespace,
        routing: RouteDecision | None = None,
    ) -> Argv | IOResult:
        clean_parts: list[TSNodeLike] = []
        for part in parts:
            if part.type != NT.PROCESS_SUBSTITUTION:
                clean_parts.append(part)
                continue
            if get_process_sub_direction(part) == ProcessSubDirection.OUTPUT:
                return IOResult(
                    exit_code=2,
                    stderr=b"mirage: unsupported: process substitution >(...)\n",
                )
            if self.dev is None:
                candidate, _, _ = registry.resolve("/dev/null")
                if not isinstance(candidate, DevVFS):
                    raise RuntimeError("missing device filesystem")
                self.dev = candidate
            path, allocation = self.dev.allocate_input()
            self.inputs.append((path, allocation))
            inner = get_process_sub_body(part)
            if inner:
                io = await child_line(
                    context, execute_fn, inner, part, call_stack
                )
                self.dev.set_input(
                    path, allocation, await materialize(io.stdout)
                )
                self.diagnostics.append(await materialize(io.stderr))
            clean_parts.append(LiteralNode(NT.WORD, encode_text(path)))
        return await own_words(
            node,
            expand_argv(
                clean_parts,
                context,
                execute_fn,
                call_stack,
                registry,
                namespace,
                view=session_view(
                    context.session,
                    registry.policies,
                    diagnostics=context.frame.diagnostics,
                ),
                routing=routing,
            ),
        )

    async def settle(self, stdout: ByteSource | None) -> ByteSource | None:
        return (
            await materialize(stdout)
            if self.inputs and stdout is not None
            else stdout
        )

    def release(self) -> None:
        if self.dev is not None:
            for path, allocation in self.inputs:
                self.dev.release_input(path, allocation)
        self.inputs.clear()
