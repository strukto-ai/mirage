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

from mirage.commands.config import ExecContext
from mirage.commands.errors import CommandTimeoutError, UsageError
from mirage.commands.spec.types import CommandSpec, FlagValue
from mirage.commands.spec.usage import read_fail_exit
from mirage.io import IOResult
from mirage.io.stream import materialize, wrap_cachable_streams
from mirage.io.types import ByteSource
from mirage.runtime.base import Runtime
from mirage.runtime.routing import RouteDecision
from mirage.runtime.table import WorkspaceRuntime
from mirage.runtime.types import DispatchFn
from mirage.shell.bytes import encode_text
from mirage.types import PathSpec
from mirage.utils.errors import format_fs_error
from mirage.workspace.executor.command.flags import parse_flags
from mirage.workspace.mount import (
    MountCommandUnsupported,
    MountEntry,
    MountRegistry,
)
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.mount.namespace.probe import path_readdir, path_stat
from mirage.workspace.mount.namespace.view import namespace_view_of
from mirage.workspace.session import SessionState, env_snapshot, session_view
from mirage.workspace.types import ExecuteLine, ExecutionNode


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
    # materialized to concrete bytes here. On the cross-mount path it is bytes.
    return ExecutionNode(
        command=cmd_str,
        stderr=await materialize(io.stderr),
        exit_code=io.exit_code,
        paths=paths,
    )


def admission_denial(cmd_name: str) -> IOResult:
    """The 126 result for a command no runtime accepted.

    Args:
        cmd_name (str): the refused command.
    """
    msg = f"{cmd_name}: no runtime accepted this line\n"
    return IOResult(exit_code=126, stderr=encode_text(msg))


def line_runtime_for(
    cmd_name: str, registry: MountRegistry, routing: RouteDecision | None
) -> tuple[Runtime | None, IOResult | None]:
    """Resolve a command against the line's routing decision.

    With no decision, the workspace's static bindings apply. With one,
    the command's runtime is looked up in the decision: its binding,
    or the decision's fallback when no entry captures it. A resolved
    WorkspaceRuntime means the executor serves the command itself (the
    workspace runtime has no interpreter door); None means no runtime
    accepted it: exit 126, like a shell refusing to exec.

    Args:
        cmd_name (str): the command being dispatched.
        registry (MountRegistry): registry holding static bindings and
            the world's workspace runtime.
        routing (RouteDecision | None): the typed line's decision.
    """
    if routing is None:
        fallback = registry.workspace_runtime
        restricted = (
            isinstance(fallback, WorkspaceRuntime) and fallback.restricted
        )
        runtime = registry.runtime_bindings.get(cmd_name)
        if runtime is fallback and fallback is not None:
            return None, None
        if runtime is None and restricted:
            return None, admission_denial(cmd_name)
        return runtime, None
    runtime = routing.bindings.get(cmd_name, routing.fallback)
    if runtime is None:
        return None, admission_denial(cmd_name)
    if isinstance(runtime, WorkspaceRuntime):
        return None, None
    return runtime, None


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


async def drop_mount_caches(registry: MountRegistry) -> None:
    """Drop every mount's cached listings and bodies after an account
    CLI write.

    An account CLI mutates its service by id, so no vfs path can be
    derived from the call and per-path invalidation has nothing to aim
    at: after `gws sheets spreadsheets create` the new file has no cache
    entry to expire, which is exactly the case that matters. Which
    mounts that service backs is not the CLI's business either (a CLI
    and a VFS are separate tiers, and a user's own CLI knows
    nothing about a user's own VFS), so the executor says the one
    thing it knows: a write happened, and every mount may be stale. A
    write verb is rare next to reads, and the cost is one cold listing
    on a mount's next read, never a wrong answer.

    Both caches go, because the two hide different writes. A stale
    listing hides a create or a delete; a stale body hides an edit, and
    these mounts cache reads, so a `cat` after `gws docs documents
    batchUpdate` would otherwise keep serving the pre-edit content
    without ever reaching Google.

    Args:
        registry (MountRegistry): registry holding the mount table.
    """
    for mount in registry.mounts():
        # Invalidate rather than clear: a cleared index reads exactly like
        # one that was never filled, so a backend whose index *is* its
        # listing (github seeds the whole tree once) cannot tell the drop
        # from an empty repository and reports the mount as gone. Expiring
        # keeps that distinction and the next read refetches.
        await mount.index.invalidate()
        if mount.cache_manager is not None:
            await mount.cache_manager.drop_prefix()


async def run_nested_line(
    execute_fn: ExecuteLine,
    session_id: str,
    line: str,
    stdin: ByteSource | None,
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
    session: SessionState,
    dispatch: DispatchFn,
    namespace: Namespace | None,
    cmd_name: str,
    paths: list[PathSpec],
    texts: list[str],
    flag_kwargs: dict[str, FlagValue],
    stdin: ByteSource | None = None,
    resolve_hint: PathSpec | None = None,
    mount: MountEntry | None = None,
    routing_decision: RouteDecision | None = None,
    argv: tuple[str, ...] = (),
    execute_fn: ExecuteLine | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Run one already-parsed command on the mount that owns its paths.

    The shared single-mount execution tail: mount resolution, session
    mode checks, ``execute_cmd``, filesystem-error formatting, ls/find
    post-processing,
    and read/write key prefixing. ``handle_command`` uses it for the normal
    path, and passes it (bound) to the cross-mount runners so each operand
    executes natively on its owning mount.

    Args:
        registry (MountRegistry): Mount registry.
        session (SessionState): Session providing cwd/env/session_id.
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
    """
    if mount is None:
        resolve_paths = [resolve_hint] if resolve_hint else paths
        try:
            mount = await registry.resolve_mount(
                cmd_name, resolve_paths, session.cwd
            )
        except MountCommandUnsupported as exc:
            return None, IOResult(exit_code=1, stderr=encode_text(f"{exc}\n"))
        if mount is None:
            return None, IOResult(
                exit_code=127,
                stderr=encode_text(f"{cmd_name}: command not found"),
            )
    if cmd_name == "find":
        flag_kwargs = scalar_find_flags(flag_kwargs)

    # The facts the backend cannot supply, offered to every command and
    # delivered only to the handlers that name them as a parameter.
    # ls/stat render stat rows from the backend's own stat, which never
    # sees namespace attr overlays (chmod/chown/touch on overlay backends)
    # or the default owner; the merge makes ls -l and stat -c agree.
    # cp/mv -u freshness checks compare the same merged mtimes, and
    # find -mtime filters on them (touch results, observed writes).
    # Symlinks are namespace state no backend readdir or stat can see.
    # A traversal command's start point is statted through the dispatcher
    # so a start point under another mount answers (`find -L` follows a
    # link across mounts before the command ever runs).
    ns = namespace_view_of(registry, namespace, dispatch)
    stat_path = (
        functools.partial(path_stat, dispatch)
        if dispatch is not None
        else None
    )
    readdir_path = (
        functools.partial(path_readdir, dispatch)
        if dispatch is not None
        else None
    )

    line_runtime, denial = line_runtime_for(
        cmd_name, registry, routing_decision
    )
    if denial is not None:
        return None, denial

    try:
        stdout, io = await mount.execute_cmd(
            cmd_name,
            paths,
            texts,
            flag_kwargs,
            ExecContext(
                limit_override=(
                    session.command_limits.get(cmd_name)
                    or mount.command_limits.get(cmd_name)
                    or registry.command_limits.get(cmd_name)
                ),
                stdin=stdin,
                cwd=session.cwd,
                dispatch=dispatch,
                session_id=session.session_id,
                env=env_snapshot(session),
                session_view=session_view(session, registry.policies),
                processes=registry.process_view(session)
                if registry.process_view is not None
                else None,
                exec_allowed=registry.is_exec_allowed(),
                exec_path_allowed=registry.exec_allowed_at,
                runtime=line_runtime,
                runtime_unavailable=registry.runtime_unavailable.get(cmd_name),
                ns=ns,
                stat_path=stat_path,
                readdir_path=readdir_path,
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
    except CommandTimeoutError:
        # A limit timeout is answered by the workspace-level handler
        # (exit 124), not here.
        raise
    except Exception as exc:
        # Every other thrown command error (a backend RuntimeError, a
        # ValueError, or a filesystem OSError) becomes this command's
        # IOResult, prefixed with the command name like GNU (prog: message)
        # and the TypeScript executor.
        return None, IOResult(
            exit_code=read_fail_exit(cmd_name, exc),
            stderr=format_fs_error(cmd_name, exc, paths),
        )

    prefix = mount.prefix.rstrip("/")
    if prefix:
        io.reads = {prefix + k: v for k, v in io.reads.items()}
        io.writes = {prefix + k: v for k, v in io.writes.items()}
        io.cache = [prefix + p for p in io.cache]
    return wrap_cachable_streams(stdout, io)
