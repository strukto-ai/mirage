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

from mirage.commands.builtin.find_parse import (find_expr_tail,
                                                parse_find_expression)
from mirage.commands.builtin.generic.crossmount import (handle_cross_mount,
                                                        is_cross_mount)
from mirage.commands.builtin.generic.crossmount.detect import strategy_for
from mirage.commands.builtin.generic.crossmount.types import Strategy
from mirage.commands.builtin.generic.tar.mode import is_create_mode
from mirage.commands.builtin.utils.identity import identity_from
from mirage.commands.builtin.utils.limit import maybe_with_timeout
from mirage.commands.config import version_request
from mirage.commands.errors import FindParseError
from mirage.commands.spec import SPECS
from mirage.io import IOResult
from mirage.io.stream import materialize
from mirage.io.types import ByteSource
from mirage.ops.types import NamespaceView, StatPath
from mirage.policy import resolve_limit, resolve_producer
from mirage.runtime.routing import RouteDecision
from mirage.runtime.types import DispatchFn
from mirage.shell.call_stack import CallStack
from mirage.shell.job_table import JobTable
from mirage.types import PathSpec, Producer
from mirage.workspace.executor.builtins.links import path_stat
from mirage.workspace.executor.command.cli import CLIContext, handle_cli
from mirage.workspace.executor.command.flags import option_error, parse_flags
from mirage.workspace.executor.command.functions import run_shell_function
from mirage.workspace.executor.command.routing import (CWD_DEFAULT_RAW,
                                                       default_cwd_operand,
                                                       merge_scopes,
                                                       path_flag_scopes)
from mirage.workspace.executor.command.types import ExecuteNodeFn
from mirage.workspace.executor.fanout import (_fan_out_traversal,
                                              _should_fan_out, run_with_fanout)
from mirage.workspace.executor.find_action_dispatch import _apply_find_actions
from mirage.workspace.executor.find_refs import resolve_newer_refs
from mirage.workspace.executor.jobs import (handle_disown, handle_fg,
                                            handle_jobs, handle_kill,
                                            handle_ps, handle_wait)
from mirage.workspace.expand.globs import glob_options, resolve_globs
from mirage.workspace.lookup import (JOB_BUILTINS, Consumer, dereferences,
                                     lookup)
from mirage.workspace.mount import MountCommandUnsupported, MountRegistry
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.mount.storage import make_storage_key
from mirage.workspace.session import Session
from mirage.workspace.session.state import session_view
from mirage.workspace.types import ExecuteLine, ExecutionNode

from mirage.workspace.executor.command.run import (  # isort: skip
    drop_service_caches, exec_node, find_start_points, namespace_view_of,
    run_on_mount, scalar_find_flags)

# One handler per JOB_BUILTINS member; lookup already narrowed the name.
JOB_HANDLERS = {
    "wait": handle_wait,
    "fg": handle_fg,
    "kill": handle_kill,
    "jobs": handle_jobs,
    "disown": handle_disown,
    "ps": handle_ps,
}


async def _finish_find(
        stdout: ByteSource | None,
        io: IOResult,
        texts: list[str],
        registry: MountRegistry,
        session: Session,
        execute_fn: ExecuteLine | None,
        ns: NamespaceView | None,
        stat_path: StatPath | None,
        dispatch: DispatchFn,
        namespace: Namespace | None = None,
        stdin: ByteSource | None = None,
        starts: list[PathSpec] | None = None) -> ByteSource | None:
    """Apply find's actions once, at the command boundary.

    Every runner below this point (one mount, a fan-out over nested
    mounts, one native run per cross-mount operand) only selects rows
    and hands them back as ``io.matched_runs``; the actions run here
    over all of them together, so a batched ``-exec {} +`` is one
    invocation across every start point, as GNU's is, and a per-match
    action runs in start-point order.

    Args:
        stdout (ByteSource | None): the rendered rows.
        io (IOResult): the selection's result, amended in place.
        texts (list[str]): the expression tokens.
        registry (MountRegistry): used to route per-match dispatch.
        session (Session): the session the line runs under.
        execute_fn (ExecuteLine | None): runs an ``-exec`` line.
        ns (NamespaceView | None): the name plane's facts.
        stat_path (StatPath | None): dispatcher stat.
        dispatch (DispatchFn): the op dispatcher a symlink row is
            deleted through.
        namespace (Namespace | None): the node table a deleted row's
            meta is dropped from.
        stdin (ByteSource | None): find's own input, for its ``-exec``
            children.
        starts (list[PathSpec] | None): the start operands, for the
            stat ``-ls`` renders after a ``-delete``.
    """
    stdout, action_err, action_exit = await _apply_find_actions(
        stdout,
        io.matched_runs,
        texts,
        registry,
        session.cwd,
        execute_fn=execute_fn,
        session_id=session.session_id,
        ns=ns,
        stat_path=stat_path,
        dispatch=dispatch,
        identity=identity_from(ns, session_view(session, registry.policies)),
        namespace=namespace,
        stdin=stdin,
        starts=starts)
    if action_err:
        existing = await materialize(io.stderr) if io.stderr else b""
        io.stderr = existing + action_err
    if io.exit_code == 0:
        io.exit_code = action_exit
    return stdout


async def handle_command(
    execute_node: ExecuteNodeFn,
    dispatch: DispatchFn,
    registry: MountRegistry,
    parts: list[str | PathSpec],
    session: Session,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
    job_table: JobTable | None = None,
    namespace: Namespace | None = None,
    routing_decision: RouteDecision | None = None,
    execute_fn: ExecuteLine | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Execute a simple command.

    Parts are already classified: strings for text,
    PathSpec for paths. Dispatches to mount.execute_cmd. ``execute_fn``
    runs a line in the session, which is how find's ``-exec`` runs its
    command.
    """
    if not parts:
        return None, IOResult(), ExecutionNode(command="", exit_code=0)

    cmd_name = str(parts[0])
    cmd_str = " ".join(p.virtual if isinstance(p, PathSpec) else p
                       for p in parts)

    # Job builtins
    if cmd_name in JOB_BUILTINS and job_table is not None:
        text_parts = [
            p.virtual if isinstance(p, PathSpec) else p for p in parts
        ]
        return await JOB_HANDLERS[cmd_name](job_table, text_parts, session,
                                            session_view(
                                                session, registry.policies))

    # Shell functions
    if cmd_name in session.functions:
        return await run_shell_function(execute_node, cmd_name, parts, session,
                                        stdin, call_stack)

    # Installed CLIs: dispatch by name, never by operand path. Sits
    # below functions (a user can wrap an installed CLI, bash-style)
    # and above every mount branch (a CLI consults no mount). A CLI that
    # works on files rather than an API (`git`) reads the workspace
    # facts it needs off `inv.doors`; the rest never look. The doors are
    # the same ones `run_on_mount` puts on `CommandOpts`, built the same
    # way, so a CLI leaf and a command handler see one plane alike.
    cli_install = registry.clis.get(cmd_name)
    if cli_install is not None:
        return await handle_cli(
            cli_install,
            parts,
            session,
            stdin,
            CLIContext(
                entries=registry.runtime_entries,
                dispatch=dispatch,
                stat_path=(functools.partial(path_stat, dispatch)
                           if dispatch is not None else None),
                ns=namespace_view_of(registry, namespace, dispatch),
                session_view=session_view(session, registry.policies),
            ),
            drop_caches=functools.partial(drop_service_caches, registry,
                                          cli_install.spec.serves),
        )

    if cmd_name in CWD_DEFAULT_RAW:
        operand = default_cwd_operand(parts, cmd_name, registry, session.cwd,
                                      stdin)
        if operand is not None:
            # Where GNU's implied `.` sits: after the pattern for
            # grep/rg (the first positional is the pattern), right
            # after the command name for find/tree/du/ls (find's
            # expression tokens must stay behind the path).
            if cmd_name in ("grep", "rg"):
                parts = [*parts, operand]
            else:
                parts = [parts[0], operand, *parts[1:]]

    # Cross-mount: paths span different mounts (e.g. cp /ram/a /disk/b).
    # Use dispatch to read/write across mounts directly.
    path_scopes = [p for p in parts[1:] if isinstance(p, PathSpec)]
    raw_argv = [p.virtual if isinstance(p, PathSpec) else p for p in parts[1:]]
    # Unknown name: nobody registers it; fail like bash before any
    # backend work. The admission policies (fired upstream at the
    # dispatch chokepoint) stay ahead of this so protective refusals
    # keep their specific messages.
    if lookup(cmd_name, session, registry) is Consumer.UNKNOWN:
        err = f"{cmd_name}: command not found\n".encode()
        return None, IOResult(exit_code=127,
                              stderr=err), ExecutionNode(command=cmd_str,
                                                         exit_code=127,
                                                         stderr=err)

    # --version answers from the package, never from a backend, so it is
    # served before mount permission checks and cross-mount routing:
    # otherwise `rm --version /ro/x` hits the read-only refusal and
    # `cat --version /ram/a /disk/b` parses against the shared spec, which
    # carries no injected --version, and fails as an unknown option.
    cmd_mount = registry.mount_for_command(cmd_name)
    version_out = version_request(
        cmd_name,
        cmd_mount.spec_for(cmd_name) if cmd_mount else None, raw_argv)
    if version_out is not None:
        return version_out, IOResult(), ExecutionNode(command=cmd_str,
                                                      exit_code=0)

    # Path-valued flags (e.g. shuf --output=/dst/out) own a mount just like
    # positional operands, so they join routing and mount validation instead
    # of being dropped whenever a positional path is also present.
    routing_scopes = merge_scopes(
        path_scopes, path_flag_scopes(cmd_name, raw_argv, session.cwd))

    find_expr_tokens: list[str] | None = None
    if cmd_name == "find":
        find_expr_tokens = find_expr_tail(raw_argv)
        try:
            find_expr = parse_find_expression(find_expr_tokens)
        except FindParseError as exc:
            msg = f"{exc}\n"
            return None, IOResult(exit_code=1,
                                  stderr=msg.encode()), ExecutionNode(
                                      command=cmd_str,
                                      exit_code=1,
                                      stderr=msg.encode())
        if find_expr.newer and dispatch is not None:
            # Every -newer reference is statted through the dispatcher
            # here, once, before any backend parses the expression.
            find_expr_tokens, ref_err = await resolve_newer_refs(
                find_expr_tokens, find_expr.newer, registry, session.cwd,
                functools.partial(path_stat, dispatch), namespace,
                dereferences(cmd_name, parts))
            if ref_err is not None:
                return None, IOResult(exit_code=1,
                                      stderr=ref_err), ExecutionNode(
                                          command=cmd_str,
                                          exit_code=1,
                                          stderr=ref_err)

    # Path-valued flags count: `cp -t /other/mount/dir src` spans mounts
    # exactly like a positional destination would. A create-mode tar is
    # the one relay member kept out: its planner walks a single
    # backend's tree, so a span there falls through to the refusal
    # below instead of a relay run that would cross nested mounts.
    if is_cross_mount(
            cmd_name, routing_scopes,
            registry) and not (cmd_name == "tar" and is_create_mode(raw_argv)):
        # Cross-mount execution bypasses a resource command handler. Parse
        # against the shared spec so flags and text operands do not depend on
        # the source mount. The bound single-mount runner lets the strategy
        # runners execute each operand natively on its owning mount.
        cross_parsed = parse_flags(parts[1:],
                                   SPECS.get(cmd_name),
                                   cmd_name,
                                   session.cwd,
                                   str_flag_paths=True)
        cross_texts = (find_expr_tokens
                       if find_expr_tokens is not None else cross_parsed.texts)
        cross_refusal = option_error(cmd_name, cross_parsed)
        if cross_refusal is not None:
            refusal_msg, code = cross_refusal
            return None, IOResult(exit_code=code,
                                  stderr=refusal_msg), ExecutionNode(
                                      command=cmd_str,
                                      exit_code=code,
                                      stderr=refusal_msg)
        cross_scopes = path_scopes
        if strategy_for(cmd_name, cross_parsed.flag_kwargs) is Strategy.RELAY:
            # STREAM and FANOUT run each operand natively on its mount, which
            # expands the operand's glob. RELAY bypasses the mount command
            # wrappers entirely, so its glob operands must expand here; an
            # unmatched glob stays the literal word, like bash.
            expanded = await resolve_globs(list(path_scopes),
                                           registry,
                                           links=namespace,
                                           options=glob_options(session))
            cross_scopes = [p for p in expanded if isinstance(p, PathSpec)]
        run_single = functools.partial(run_on_mount,
                                       registry,
                                       session,
                                       dispatch,
                                       namespace,
                                       routing_decision=routing_decision)
        cross_ns = namespace_view_of(registry, namespace, dispatch)
        # A per-operand native run is single-mount by construction, so a
        # traversal operand holding nested mounts has to fan out inside
        # it, exactly as the same operand would on a line of its own.
        cross_stat = (functools.partial(path_stat, dispatch)
                      if dispatch is not None else None)
        run_operand = functools.partial(run_with_fanout, run_single, registry,
                                        session.cwd, cross_ns, cross_stat)
        stdout, io = await handle_cross_mount(
            cmd_name,
            cross_scopes,
            cross_texts,
            cross_parsed.flag_kwargs,
            dispatch,
            run_operand,
            stdin=stdin,
            storage_key=make_storage_key(registry),
            ns=cross_ns,
            session_view=session_view(session, registry.policies))
        if cmd_name == "find":
            stdout = await _finish_find(stdout,
                                        io,
                                        cross_texts,
                                        registry,
                                        session,
                                        execute_fn,
                                        cross_ns,
                                        cross_stat,
                                        dispatch,
                                        namespace=namespace,
                                        stdin=stdin,
                                        starts=cross_scopes)
        if cross_parsed.warnings:
            warn = "".join(f"{cmd_name}: {w}\n"
                           for w in cross_parsed.warnings).encode()
            existing = await materialize(io.stderr) if io.stderr else b""
            io.stderr = warn + existing
        # The native sub-runs carry their own mount's scope; the
        # cross-mount command as a whole is bounded by the strictest
        # cap across the operand mounts, regardless of which sub-run
        # merged last.
        mounts = []
        for s in path_scopes:
            m = registry.try_mount_for(s.virtual)
            # a scope outside any mount contributes nothing here
            if m is not None:
                mounts.append(m)
        io.producer = Producer(command=cmd_name,
                               prefixes=tuple(m.prefix for m in mounts))
        stdout = maybe_with_timeout(stdout, resolve_limit(cmd_name, mounts),
                                    cmd_name)
        return stdout, io, await exec_node(cmd_str, io, path_scopes)

    # Reject unsupported cross-mount commands. Path-flag targets count: a
    # command bound to one mount cannot write its output through another.
    if len(routing_scopes) >= 2:
        mount_prefixes = set()
        for s in routing_scopes:
            m = registry.try_mount_for(s.virtual)
            # a scope outside any mount contributes nothing here
            if m is not None:
                mount_prefixes.add(m.prefix)
        if len(mount_prefixes) > 1:
            prefixes_str = ", ".join(sorted(mount_prefixes))
            span_err = (f"{cmd_name}: paths span multiple mounts "
                        f"({prefixes_str}), cross-mount not supported\n")
            return None, IOResult(
                exit_code=1,
                stderr=span_err.encode(),
            ), ExecutionNode(command=cmd_str, exit_code=1)

    try:
        mount = await registry.resolve_mount(cmd_name, routing_scopes,
                                             session.cwd)
    except MountCommandUnsupported as exc:
        err = f"{exc}\n".encode()
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command=cmd_str,
                                                         exit_code=1,
                                                         stderr=err)
    if mount is None:
        return None, IOResult(
            exit_code=127,
            stderr=f"{cmd_name}: command not found".encode(),
        ), ExecutionNode(command=cmd_str, exit_code=127)

    # Parse flags upstream — mount receives clean args
    single_parsed = parse_flags(parts[1:], mount.spec_for(cmd_name), cmd_name,
                                session.cwd)
    paths, texts, flag_kwargs, parse_warnings = (single_parsed.paths,
                                                 single_parsed.texts,
                                                 single_parsed.flag_kwargs,
                                                 single_parsed.warnings)
    refusal = option_error(cmd_name, single_parsed)
    if refusal is not None:
        refusal_msg, code = refusal
        return None, IOResult(exit_code=code,
                              stderr=refusal_msg), ExecutionNode(
                                  command=cmd_str,
                                  exit_code=code,
                                  stderr=refusal_msg)

    if find_expr_tokens is not None:
        texts = find_expr_tokens
        flag_kwargs = scalar_find_flags(flag_kwargs)
        # The start points are the path words before the expression;
        # the spec's rest slot would otherwise read an -exec word as one.
        paths = find_start_points(parts[1:], find_expr_tokens,
                                  mount.spec_for(cmd_name), session.cwd)

    warn_bytes = ("".join(
        f"{cmd_name}: {w}\n"
        for w in parse_warnings).encode() if parse_warnings else b"")

    single_ns = namespace_view_of(registry, namespace, dispatch)
    single_stat = (functools.partial(path_stat, dispatch)
                   if dispatch is not None else None)
    if _should_fan_out(cmd_name, paths, flag_kwargs, registry):
        # The name plane's facts plus the dispatcher-backed start-point
        # stat. A start point only the namespace serves (a nested
        # mount's ancestor) has no backend listing, so without them the
        # primary run reports the operand missing.
        stdout, io, node = await _fan_out_traversal(cmd_name,
                                                    paths,
                                                    texts,
                                                    flag_kwargs,
                                                    registry,
                                                    mount,
                                                    session.cwd,
                                                    cmd_str,
                                                    stdin,
                                                    ns=single_ns,
                                                    stat_path=single_stat)
        if cmd_name == "find":
            stdout = await _finish_find(stdout,
                                        io,
                                        texts,
                                        registry,
                                        session,
                                        execute_fn,
                                        single_ns,
                                        single_stat,
                                        dispatch,
                                        namespace=namespace,
                                        stdin=stdin,
                                        starts=paths)
            node.exit_code = io.exit_code
            node.stderr = await materialize(io.stderr) if io.stderr else b""
        if warn_bytes:
            existing = await materialize(io.stderr) if io.stderr else b""
            io.stderr = warn_bytes + existing
            node.stderr = warn_bytes + (node.stderr or b"")
        return stdout, io, node

    stdout, io = await run_on_mount(registry,
                                    session,
                                    dispatch,
                                    namespace,
                                    cmd_name,
                                    paths,
                                    texts,
                                    flag_kwargs,
                                    stdin=stdin,
                                    mount=mount,
                                    routing_decision=routing_decision)
    if cmd_name == "find":
        stdout = await _finish_find(stdout,
                                    io,
                                    texts,
                                    registry,
                                    session,
                                    execute_fn,
                                    single_ns,
                                    single_stat,
                                    dispatch,
                                    namespace=namespace,
                                    stdin=stdin,
                                    starts=paths)

    if warn_bytes:
        existing = await materialize(io.stderr) if io.stderr else b""
        io.stderr = warn_bytes + existing

    resolved = (resolve_producer(io.producer, registry.limit_override)
                if io.producer is not None else None)
    stdout = maybe_with_timeout(stdout, resolved, cmd_name)
    io.stderr = maybe_with_timeout(io.stderr, resolved, cmd_name)

    return stdout, io, await exec_node(cmd_str, io, paths)
