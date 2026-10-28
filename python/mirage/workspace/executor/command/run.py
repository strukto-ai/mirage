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

import functools
import logging
from typing import Any

from mirage.commands.config import Context
from mirage.commands.errors import UsageError
from mirage.commands.spec.types import CommandSpec, FlagValue
from mirage.commands.spec.usage import read_fail_exit_code
from mirage.context.session_context import session_access
from mirage.errors.render import format_fs_error
from mirage.errors.types import CommandTimeoutError
from mirage.io import IOResult
from mirage.io.errors import PipeClosed
from mirage.io.types import ByteSource
from mirage.runtime.base import Runtime
from mirage.runtime.types import (
    CommandRuntime,
    DispatchFn,
    RouteDecision,
    RuntimeIdentity,
)
from mirage.runtime.workspace import WorkspaceRuntime
from mirage.shell.bytes import encode_text
from mirage.shell.constants import CANNOT_EXECUTE_STATUS, NOT_FOUND_STATUS
from mirage.types import PathSpec
from mirage.view.types import FollowOperands
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.executor.command.flags import parse_flags
from mirage.workspace.files import Files
from mirage.workspace.mount import (
    MountCommandUnsupported,
    MountEntry,
    MountRegistry,
)
from mirage.workspace.mount.errors import MountCommandAmbiguous
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.session import env_snapshot, session_view
from mirage.workspace.types import ExecuteLine, ExecutionNode

logger = logging.getLogger(__name__)


async def exec_node(
    cmd_str: str, io: IOResult, paths: list[PathSpec]
) -> ExecutionNode:
    """Build the recorded execution node, materializing any streamed stderr.

    Args:
        cmd_str (str): Original command text for the record.
        io (IOResult): Command result whose stderr/exit_code the node carries.
        paths (list[PathSpec]): Classified path operands, carried so the
            lazy-stream drain can respell filesystem errors as typed.
    """
    # The node is a recorded artifact (compared by value, serialized via a
    # sync to_dict, sometimes read twice), so the live lazy io.stderr is
    # materialized to concrete bytes here, and the bytes stay on io so the
    # caller still reads them. On the cross-mount path it is bytes. A
    # result whose fields fill in as its output drains (a runtime's run)
    # brings the node up to date once they have.
    node = ExecutionNode(
        command=cmd_str,
        stderr=await io.materialize_stderr(),
        exit_code=io.exit_code,
        paths=paths,
    )
    state = io.output
    if state is not None and not state.settled:
        state.callbacks.append(functools.partial(_settled, node, io))
    return node


def _settled(node: ExecutionNode, io: IOResult) -> None:
    """Record what a result settled as its output drained.

    Args:
        node (ExecutionNode): the command's record.
        io (IOResult): its result, settled.
    """
    node.exit_code = io.exit_code
    if isinstance(io.stderr, bytes):
        node.stderr = io.stderr


def admission_denial(cmd_name: str) -> IOResult:
    """The 126 result for a command no runtime accepted.

    Args:
        cmd_name (str): the refused command.
    """
    msg = f"{cmd_name}: no runtime accepted this line\n"
    return IOResult(exit_code=CANNOT_EXECUTE_STATUS, stderr=encode_text(msg))


def line_runtime_for(
    cmd_name: str,
    routing: RouteDecision[RuntimeIdentity],
) -> tuple[Runtime[Any] | None, IOResult | None]:
    """Resolve a command against the line's routing decision.

    The command's runtime is looked up in the decision: its binding,
    or the decision's fallback when no entry captures it. A resolved
    WorkspaceRuntime means the executor serves the command itself (the
    workspace runtime has no interpreter entry point); None means no runtime
    accepted it: exit 126, like a shell refusing to exec.

    Args:
        cmd_name (str): the command being dispatched.
        routing (RouteDecision): the typed line's decision.
    """
    runtime = routing.bindings.get(cmd_name, routing.fallback)
    if runtime is None:
        return None, admission_denial(cmd_name)
    if isinstance(runtime, WorkspaceRuntime):
        return None, None
    return Runtime.require(runtime), None


def find_start_points(
    argv: list[str | PathSpec],
    expr_tokens: list[str],
    spec: CommandSpec | None,
    cwd: str,
) -> list[PathSpec]:
    """find's start points: the path operands typed before its expression.

    The expression tail is the parser's, so a word inside it (an
    ``-exec`` command word, a ``-newer`` reference) is never a start
    point even when the rest slot's PATH kind would have read it as one.
    Only the head is parsed against the spec, so what it yields as path
    operands is exactly the start points.

    Args:
        argv (list[str | PathSpec]): the classified words after `find`.
        expr_tokens (list[str]): the expression tail, as `find_expr_tail`
            cut it off the same words.
        spec (CommandSpec | None): find's spec on the mount.
        cwd (str): the session's working directory.
    """
    head = argv[: len(argv) - len(expr_tokens)]
    return parse_flags(head, spec, "find", cwd).paths


def scalar_find_flags(
    flag_kwargs: dict[str, FlagValue],
) -> dict[str, FlagValue]:
    # `multiple=True` on find value-flags makes parse_to_kwargs emit
    # lists; bespoke backend wrappers read these as scalars. Migrated
    # backends read the expression from `texts` and ignore flag_kwargs.
    return {
        k: (v[-1] if isinstance(v, list) and v else v)
        for k, v in flag_kwargs.items()
    }


async def run_nested_line(
    execute_fn: ExecuteLine,
    session_id: str,
    line: str,
    stdin: ByteSource | None = None,
) -> IOResult:
    """Run a line a command handler asked for, in the handler's session.

    Args:
        execute_fn (ExecuteLine): runs a line in a session.
        session_id (str): the session the calling command runs under.
        line (str): the line.
        stdin (ByteSource | None): its input, None for the ambient one.
    """
    return await execute_fn(line, session_id=session_id, stdin=stdin)


async def run_on_mount(
    registry: MountRegistry,
    context: EvaluationContext,
    dispatch: DispatchFn,
    namespace: Namespace | None,
    cmd_name: str,
    paths: list[PathSpec],
    texts: list[str],
    flag_kwargs: dict[str, FlagValue],
    stdin: ByteSource | None = None,
    resolve_hint: PathSpec | None = None,
    mount: MountEntry | None = None,
    argv: tuple[str, ...] = (),
    execute_fn: ExecuteLine | None = None,
    follow: FollowOperands | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Run one already-parsed command on the mount that owns its paths.

    The shared single-mount execution tail: mount resolution, session
    mode checks, ``run_command``, filesystem-error formatting and ls/find
    post-processing. ``handle_command`` uses it for the normal path, and
    passes it (bound) to the cross-mount runners so each operand executes
    natively on its owning mount.

    Args:
        registry (MountRegistry): Mount registry.
        context (EvaluationContext): its session gives cwd, env and session_id.
        dispatch (Callable): Workspace operation dispatcher.
        namespace (Namespace | None): Addressing authority for ls symlinks.
        cmd_name (str): Command name.
        paths (list[PathSpec]): Positional path operands (may hold globs;
            the mount wrapper expands them natively).
        texts (list[str]): Positional text operands.
        flag_kwargs (dict): Parsed flags forwarded to the mount command.
        stdin (ByteSource | None): Standard input for the command.
        resolve_hint (PathSpec | None): The path whose mount runs the
            command, ahead of the first of ``paths``: a stream command in
            stdin mode has none, and awk over operands on several mounts
            runs where its first file lives.
        mount: Pre-resolved mount; skips resolution and session mode
            checks, which the caller already performed.
        argv (tuple[str, ...]): The words after the command name, as the
            line spelled them; empty for a run split out of a line.
        execute_fn (ExecuteLine | None): Runs a nested line, which the
            handler reaches as ``opts.shell``; None outside a workspace.
        follow (FollowOperands | None): the line's operand resolution,
            which the command's globs give their matches.
    """
    session = context.session
    if mount is None:
        resolve_paths = [resolve_hint] if resolve_hint else paths
        try:
            mount = await registry.resolve_mount(
                cmd_name,
                resolve_paths,
                session.cwd,
                argv,
                session_access(session),
            )
        except (MountCommandUnsupported, MountCommandAmbiguous) as exc:
            return None, IOResult(exit_code=1, stderr=encode_text(f"{exc}\n"))
        if mount is None:
            return None, IOResult(
                exit_code=NOT_FOUND_STATUS,
                stderr=encode_text(f"{cmd_name}: command not found"),
            )
    if cmd_name == "find":
        flag_kwargs = scalar_find_flags(flag_kwargs)

    routing = context.frame.routing
    assert routing is not None
    line_runtime, denial = line_runtime_for(cmd_name, routing)
    if denial is not None:
        return None, denial

    try:
        return await mount.run_command(
            cmd_name,
            paths,
            texts,
            flag_kwargs,
            Context(
                diff=registry.diff,
                ids=registry.ids,
                stdin=stdin,
                cwd=PathSpec.from_str_path(session.cwd),
                vfs=Files(
                    dispatch,
                    (
                        namespace.readers(lambda _session: session.visibility)
                        if namespace is not None
                        else None
                    ),
                    follow=follow,
                    ledger=False,
                ),
                env=env_snapshot(session),
                session=session_view(
                    session,
                    registry.policies,
                    diagnostics=context.frame.diagnostics,
                ),
                processes=registry.process_view(session)
                if registry.process_view is not None
                else None,
                runtime=CommandRuntime(
                    bound=line_runtime,
                    unavailable=registry.runtime_unavailable.get(cmd_name),
                    exec_allowed=registry.is_exec_allowed(),
                    exec_path_allowed=registry.exec_allowed_at,
                    settle=(
                        functools.partial(registry.settle, line_runtime)
                        if line_runtime is not None
                        else None
                    ),
                ),
                shell=(
                    functools.partial(
                        run_nested_line, execute_fn, session.session_id
                    )
                    if execute_fn is not None
                    else None
                ),
                argv=argv,
            ),
        )
    except UsageError as exc:
        # Command-owned usage errors (extra operands, missing patterns)
        # become this command's IOResult so the rest of the line keeps
        # running, like a real shell (#452).
        return None, IOResult(
            exit_code=exc.exit_code, stderr=encode_text(f"{exc}\n")
        )
    except (CommandTimeoutError, PipeClosed):
        # A limit timeout is answered by the workspace-level handler
        # (exit 124), and a write into a pipe whose reader has gone is
        # SIGPIPE, which the executor answers for the writer: neither is
        # this command's error to word.
        raise
    except Exception as exc:
        # Every other thrown command error (a backend RuntimeError, a
        # ValueError, or a filesystem OSError) becomes this command's
        # IOResult, prefixed with the command name like GNU (prog: message)
        # and the TypeScript executor.
        logger.debug("%s failed", cmd_name, exc_info=True)
        return None, IOResult(
            exit_code=read_fail_exit_code(cmd_name, exc),
            stderr=format_fs_error(cmd_name, exc, paths),
        )
