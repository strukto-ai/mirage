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
from collections.abc import Callable
from typing import Any, NamedTuple

from mirage.commands.builtin.find_parse import (FindParseError, find_expr_tail,
                                                parse_find_expression)
from mirage.commands.builtin.generic.crossmount import (handle_cross_mount,
                                                        is_cross_mount)
from mirage.commands.builtin.utils.safeguard import maybe_with_timeout
from mirage.commands.errors import UsageError
from mirage.commands.safeguard import resolve_across_mounts, resolve_safeguard
from mirage.commands.spec import (SPECS, CommandSpec, OperandKind,
                                  flag_kwarg_name, parse_command,
                                  parse_to_kwargs)
from mirage.commands.spec.usage import (missing_value_error,
                                        unknown_option_error)
from mirage.io import IOResult
from mirage.io.stream import async_chain, materialize, wrap_cachable_streams
from mirage.io.types import ByteSource
from mirage.runtime.base import Runtime
from mirage.runtime.route import RoutingDecision
from mirage.runtime.table import VfsRuntime
from mirage.shell.call_stack import CallStack
from mirage.shell.job_table import JobTable
from mirage.shell.types import ERREXIT_EXEMPT_TYPES
from mirage.types import FileStat, PathSpec, word_text
from mirage.utils.errors import FS_ERRORS, format_fs_error
from mirage.workspace.executor.control import ReturnSignal
from mirage.workspace.executor.fanout import (_fan_out_traversal,
                                              _should_fan_out)
from mirage.workspace.executor.find_action_dispatch import _apply_find_actions
from mirage.workspace.executor.jobs import (handle_jobs, handle_kill,
                                            handle_ps, handle_wait)
from mirage.workspace.mount import (MountCommandUnsupported, MountEntry,
                                    MountRegistry)
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.mount.namespace.overlay import merge_overlay_stat
from mirage.workspace.route import JOB_BUILTINS, Consumer, route
from mirage.workspace.session import Session, assert_mount_allowed
from mirage.workspace.types import ExecutionNode

_FIND_ACTION_FLAGS = frozenset({"delete", "print0", "ls"})


async def _exec_node(cmd_str: str, io: IOResult,
                     paths: list[PathSpec]) -> ExecutionNode:
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
    return ExecutionNode(command=cmd_str,
                         stderr=await materialize(io.stderr),
                         exit_code=io.exit_code,
                         paths=paths)


def _check_mount_root_guard_raw(
    cmd_name: str,
    paths: list[PathSpec],
    registry: MountRegistry,
    argv: list[str],
) -> tuple[str, int] | None:
    """Refuse destructive/conflicting ops targeting a mount root.

    Fires before mount resolution / cross-mount routing so a refusal
    message is consistent regardless of whether the operands span mounts.
    Returns (stderr_message, exit_code) when the guard fires, else None.

    Args:
        cmd_name (str): command name (rm/mv/mkdir/touch/ln/...).
        paths (list[PathSpec]): raw positional path arguments.
        registry (MountRegistry): mount registry for is_mount_root checks.
        argv (list[str]): raw argv after the command name (used to spot
            shorthand flags like `mkdir -p` before _parse_flags runs).
    """
    if not paths:
        return None

    def _is_root(p: PathSpec) -> bool:
        return registry.is_mount_root(p.virtual)

    if cmd_name in ("rm", "rmdir"):
        for p in paths:
            if _is_root(p):
                if cmd_name == "rmdir":
                    msg = (f"rmdir: failed to remove '{p.virtual}': "
                           f"Device or resource busy\n")
                else:
                    msg = (f"rm: cannot remove '{p.virtual}': "
                           f"Device or resource busy\n")
                return msg, 1
    elif cmd_name == "mv":
        if _is_root(paths[0]):
            dst = paths[1].virtual if len(paths) > 1 else "?"
            msg = (f"mv: cannot move '{paths[0].virtual}' to '{dst}': "
                   f"Device or resource busy\n")
            return msg, 1
    elif cmd_name == "mkdir":
        # GNU mkdir -p makes "already exists" a no-op.
        for tok in argv:
            if isinstance(tok,
                          str) and (tok == "-p" or tok == "--parents" or
                                    (tok.startswith("-") and "p" in tok[1:]
                                     and not tok.startswith("--"))):
                return None
        for p in paths:
            if _is_root(p):
                msg = (f"mkdir: cannot create directory '{p.virtual}': "
                       f"File exists\n")
                return msg, 1
    elif cmd_name == "touch":
        for p in paths:
            if _is_root(p):
                msg = (f"touch: cannot touch '{p.virtual}': "
                       f"Is a directory\n")
                return msg, 1
    elif cmd_name == "ln":
        if _is_root(paths[-1]):
            msg = (f"ln: failed to create link '{paths[-1].virtual}': "
                   f"File exists\n")
            return msg, 1
    return None


def _admission_denial(cmd_name: str) -> IOResult:
    """The 126 result for a command no runtime accepted.

    Args:
        cmd_name (str): the refused command.
    """
    msg = f"mirage: {cmd_name}: no runtime accepted this line\n"
    return IOResult(exit_code=126, stderr=msg.encode())


def _line_runtime(
        cmd_name: str, registry: MountRegistry, routing: RoutingDecision | None
) -> tuple[Runtime | None, IOResult | None]:
    """Resolve a command against the line's routing decision.

    With no decision, the workspace's static bindings apply. With one,
    the command's runtime is looked up in the decision: its binding,
    or the decision's fallback when no entry captures it. A resolved
    VfsRuntime means the executor serves the command itself (the vfs
    runtime has no interpreter door); None means no runtime accepted
    it: exit 126, like a shell refusing to exec.

    Args:
        cmd_name (str): the command being dispatched.
        registry (MountRegistry): registry holding static bindings and
            the world's vfs runtime.
        routing (RoutingDecision | None): the typed line's decision.
    """
    if routing is None:
        vfs = registry.vfs_runtime
        restricted = isinstance(vfs, VfsRuntime) and vfs.restricted
        runtime = registry.runtime_bindings.get(cmd_name)
        if runtime is vfs and vfs is not None:
            return None, None
        if runtime is None and restricted:
            return None, _admission_denial(cmd_name)
        return runtime, None
    runtime = routing.bindings.get(cmd_name, routing.fallback)
    if runtime is None:
        return None, _admission_denial(cmd_name)
    if isinstance(runtime, VfsRuntime):
        return None, None
    return runtime, None


def _scalar_find_flags(flag_kwargs: dict[str, object]) -> dict[str, Any]:
    # `repeatable=True` on find value-flags makes parse_to_kwargs emit
    # lists; bespoke backend wrappers read these as scalars. Migrated
    # backends read the expression from `texts` and ignore flag_kwargs.
    return {
        k: (v[-1] if isinstance(v, list) and v else v)
        for k, v in flag_kwargs.items()
    }


def _namespace_stat_overlay(namespace: Namespace, virtual: str,
                            stat: FileStat) -> FileStat:
    """Merge namespace attr overlays into one stat row (ls rendering).

    Args:
        namespace (Namespace): addressing authority holding the overlay.
        virtual (str): absolute virtual path of the statted entry.
        stat (FileStat): backend stat result.
    """
    return merge_overlay_stat(namespace.meta_for(virtual), stat)


async def run_on_mount(
    registry: MountRegistry,
    session: Session,
    dispatch: Callable[..., Any],
    namespace: Namespace | None,
    cmd_name: str,
    paths: list[PathSpec],
    texts: list[str],
    flag_kwargs: dict[str, object],
    stdin: ByteSource | None = None,
    resolve_hint: PathSpec | None = None,
    mount: MountEntry | None = None,
    routing_decision: RoutingDecision | None = None,
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
        session (Session): Session providing cwd/env/session_id.
        dispatch (Callable): Workspace operation dispatcher.
        namespace (Namespace | None): Addressing authority for ls symlinks.
        cmd_name (str): Command name.
        paths (list[PathSpec]): Positional path operands (may hold globs;
            the mount wrapper expands them natively).
        texts (list[str]): Positional text operands.
        flag_kwargs (dict): Parsed flags forwarded to the mount command.
        stdin (ByteSource | None): Standard input for the command.
        resolve_hint (PathSpec | None): Mount-resolution path when ``paths``
            is empty (a stream command running in stdin mode).
        mount: Pre-resolved mount; skips resolution and session mode
            checks, which the caller already performed.
    """
    if mount is None:
        resolve_paths = paths or ([resolve_hint] if resolve_hint else [])
        try:
            mount = await registry.resolve_mount(cmd_name, resolve_paths,
                                                 session.cwd)
        except MountCommandUnsupported as exc:
            return None, IOResult(exit_code=1, stderr=f"{exc}\n".encode())
        if mount is None:
            return None, IOResult(
                exit_code=127,
                stderr=f"{cmd_name}: command not found".encode())
        try:
            assert_mount_allowed(mount.prefix)
            for ps in paths:
                target = registry.mount_for(ps.virtual)
                assert_mount_allowed(target.prefix)
        except PermissionError as exc:
            return None, IOResult(exit_code=1, stderr=f"{exc}\n".encode())

    if cmd_name == "find":
        flag_kwargs = _scalar_find_flags(flag_kwargs)

    # ls renders stat rows from the backend's own stat, which never sees
    # namespace attr overlays (chmod/chown/touch on overlay backends);
    # inject the merge so ls -l and the ops facade agree.
    stat_overlay = (functools.partial(_namespace_stat_overlay, namespace)
                    if cmd_name == "ls" and namespace is not None else None)

    line_runtime, denial = _line_runtime(cmd_name, registry, routing_decision)
    if denial is not None:
        return None, denial

    try:
        stdout, io = await mount.execute_cmd(
            cmd_name,
            paths,
            texts,
            flag_kwargs,
            stdin=stdin,
            cwd=session.cwd,
            dispatch=dispatch,
            session_id=session.session_id,
            env=session.env,
            exec_allowed=registry.is_exec_allowed(),
            runtime=line_runtime,
            stat_overlay=stat_overlay,
        )
    except UsageError as exc:
        # Command-owned usage errors (extra operands, missing patterns)
        # become this command's IOResult so the rest of the line keeps
        # running, like a real shell (#452).
        return None, IOResult(exit_code=exc.exit_code,
                              stderr=f"{exc}\n".encode())
    except FS_ERRORS as exc:
        err = format_fs_error(cmd_name, exc, paths)
        return None, IOResult(exit_code=1, stderr=err)

    if cmd_name == "ls" and io.exit_code == 0:
        stdout = await _inject_child_mounts(stdout, registry, paths,
                                            flag_kwargs, session.cwd)
        if namespace is not None and namespace.has_links():
            stdout = await _inject_links(stdout, namespace, paths, flag_kwargs,
                                         session.cwd)

    if cmd_name == "find":
        stdout, action_err = await _apply_find_actions(stdout, flag_kwargs,
                                                       registry, session.cwd)
        if action_err:
            existing = await materialize(io.stderr) if io.stderr else b""
            io.stderr = existing + action_err
            if io.exit_code == 0:
                io.exit_code = 1

    prefix = mount.prefix.rstrip("/")
    if prefix:
        io.reads = {prefix + k: v for k, v in io.reads.items()}
        io.writes = {prefix + k: v for k, v in io.writes.items()}
        io.cache = [prefix + p for p in io.cache]
    return wrap_cachable_streams(stdout, io)


class _ParsedCommand(NamedTuple):
    paths: list[PathSpec]
    texts: list[str]
    flag_kwargs: dict[str, object]
    warnings: list[str]
    invalid_options: list[str]
    needs_value_options: list[str]


def _parse_flags(
    parts: list[str | PathSpec],
    spec: CommandSpec | None,
    cmd_name: str,
    cwd: str,
    str_flag_paths: bool = False,
) -> _ParsedCommand:
    """Parse flags from classified parts, recovering PathSpec for PATH values.

    Single-mount dispatch and cross-mount dispatch both parse through
    here, so flags, texts, and parser warnings cannot drift between the
    two paths (a cross-mount `grep --bogus` used to lose its warning).

    Args:
        parts (list[str | PathSpec]): expanded command words after the
            command name; path-classified words arrive as PathSpec.
        spec (CommandSpec | None): command spec, from the owning mount on
            the single-mount path or the shared SPECS registry on the
            cross-mount path; None falls back to type separation.
        cmd_name (str): command name used in warnings.
        cwd (str): current working directory for relative path resolution.
        str_flag_paths (bool): keep PATH flag values as their resolved
            virtual-path strings instead of PathSpec. Cross-mount
            strategies read flags through FlagView, which type-checks
            str, so they get the string view.

    Returns:
        _ParsedCommand: positional paths, positional texts, parsed flag dict
        (PATH flag values recovered to PathSpec, repeatable PATH flags to
        list[PathSpec]), and parser warnings (e.g. ignored unknown options).
    """
    # Build string argv and PathSpec lookup
    argv = [
        item.virtual if isinstance(item, PathSpec) else item for item in parts
    ]
    scope_map: dict[str, PathSpec] = {}
    for item in parts:
        if isinstance(item, PathSpec):
            scope_map[item.virtual] = item
            stripped = item.virtual.rstrip("/")
            if stripped and stripped != item.virtual:
                scope_map[stripped] = item

    if spec is not None:
        parsed = parse_command(spec, argv, cwd=cwd)
        flag_kwargs = parse_to_kwargs(parsed)

        # Recover PathSpec for PATH flag values; repeatable PATH flags
        # arrive as a list of resolved paths and become list[PathSpec].
        # A relative PATH flag value cwd-resolved by parse_command (e.g.
        # csplit -f part -> /data/part) is absent from scope_map, so build a
        # PathSpec for it just like positional paths do, otherwise it never
        # gets the mount prefix stripped.
        repeat_path_keys = {
            flag_kwarg_name(name)
            for opt in spec.options
            if opt.value_kind == OperandKind.PATH and opt.repeatable
            for name in (opt.short, opt.long) if name
        }
        single_path_keys = {
            flag_kwarg_name(name)
            for opt in spec.options
            if opt.value_kind == OperandKind.PATH and not opt.repeatable
            for name in (opt.short, opt.long) if name
        }
        if not str_flag_paths:
            for key, value in flag_kwargs.items():
                if key in repeat_path_keys and isinstance(value, list):
                    flag_kwargs[key] = [
                        scope_map.get(
                            part,
                            PathSpec(virtual=part,
                                     directory=part[:part.rfind("/") + 1]
                                     or "/",
                                     resource_path="",
                                     resolved=True)) for part in value
                    ]
                elif key in single_path_keys and isinstance(value, str):
                    flag_kwargs[key] = scope_map.get(
                        value,
                        PathSpec(virtual=value,
                                 directory=value[:value.rfind("/") + 1] or "/",
                                 resource_path="",
                                 resolved=True))
                elif isinstance(value, str) and value in scope_map:
                    flag_kwargs[key] = scope_map[value]

        # Classify positional args
        paths: list[PathSpec] = []
        texts: list[str] = []
        for value, kind in parsed.args:
            if kind == OperandKind.PATH:
                scope = scope_map.get(value)
                if scope is None:
                    scope = PathSpec(
                        virtual=value,
                        directory=value[:value.rfind("/") + 1] or "/",
                        resource_path="",
                        resolved=True,
                    )
                paths.append(scope)
            else:
                texts.append(value)
        return _ParsedCommand(paths, texts, flag_kwargs, parsed.warnings,
                              parsed.invalid_options,
                              parsed.needs_value_options)

    # No spec: separate by type
    paths = [item for item in parts if isinstance(item, PathSpec)]
    texts = [item for item in parts if not isinstance(item, PathSpec)]
    return _ParsedCommand(paths, texts, {}, [], [], [])


def _option_error(cmd_name: str,
                  parsed: _ParsedCommand) -> tuple[bytes, int] | None:
    """GNU-shaped refusal for option errors the parser reported.

    find is exempt: its expression tokens are validated by
    parse_find_expression, which raises the GNU predicate error itself.

    Args:
        cmd_name (str): command name for message shape and exit code.
        parsed (_ParsedCommand): parse result carrying the reports.
    """
    if cmd_name == "find":
        return None
    if parsed.invalid_options:
        return unknown_option_error(cmd_name, parsed.invalid_options[0])
    if parsed.needs_value_options:
        return missing_value_error(cmd_name, parsed.needs_value_options[0])
    return None


async def handle_command(
    execute_node: Callable[..., Any],
    dispatch: Callable[..., Any],
    registry: MountRegistry,
    parts: list[str | PathSpec],
    session: Session,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
    job_table: JobTable | None = None,
    namespace: Namespace | None = None,
    routing_decision: RoutingDecision | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Execute a simple command.

    Parts are already classified: strings for text,
    PathSpec for paths. Dispatches to mount.execute_cmd.
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
        if cmd_name in ("wait", "fg"):
            return await handle_wait(job_table, text_parts)
        if cmd_name == "kill":
            return await handle_kill(job_table, text_parts)
        if cmd_name == "jobs":
            return await handle_jobs(job_table, text_parts)
        if cmd_name == "ps":
            return await handle_ps(job_table, text_parts)

    # Shell functions
    if cmd_name in session.functions:
        func_body = session.functions[cmd_name]
        cs = call_stack if call_stack is not None else CallStack()
        # Positional args carry the word as typed ($1 stays sub/a.txt).
        text_args = [word_text(p) for p in parts[1:]]
        cs.push(text_args, function_name=cmd_name)
        saved_locals: dict[str, str | None] = {}
        session._local_vars = saved_locals
        try:
            all_stdout: list[Any] = []
            merged_io = IOResult()
            last_exec = ExecutionNode(command=cmd_name, exit_code=0)
            for cmd in func_body:
                try:
                    stdout, io, last_exec = await execute_node(
                        cmd, session, stdin, cs)
                except ReturnSignal as sig:
                    if sig.stderr:
                        merged_io = await merged_io.merge(
                            IOResult(stderr=sig.stderr))
                    merged_io.exit_code = sig.exit_code
                    break
                if stdout is not None:
                    all_stdout.append(stdout)
                merged_io = await merged_io.merge(io)
                if (io.exit_code != 0 and session.shell_options.get("errexit")
                        and cmd.type not in ERREXIT_EXEMPT_TYPES):
                    merged_io.exit_code = io.exit_code
                    break
            combined = async_chain(*all_stdout) if all_stdout else None
            last_exec.exit_code = merged_io.exit_code
            return combined, merged_io, last_exec
        finally:
            cs.pop()
            for key, old_val in saved_locals.items():
                if old_val is None:
                    session.env.pop(key, None)
                else:
                    session.env[key] = old_val
            session._local_vars = None

    # Cross-mount: paths span different mounts (e.g. cp /ram/a /disk/b).
    # Use dispatch to read/write across mounts directly.
    path_scopes = [p for p in parts[1:] if isinstance(p, PathSpec)]
    raw_argv = [p.virtual if isinstance(p, PathSpec) else p for p in parts[1:]]
    early_guard = _check_mount_root_guard_raw(cmd_name, path_scopes, registry,
                                              raw_argv)
    if early_guard is not None:
        msg, code = early_guard
        return None, IOResult(exit_code=code,
                              stderr=msg.encode()), ExecutionNode(
                                  command=cmd_str,
                                  exit_code=code,
                                  stderr=msg.encode())

    # Unknown name: nobody registers it; fail like bash before any
    # backend work. The mount-root guard stays ahead of this so
    # protective refusals keep their specific messages.
    if route(cmd_name, session, registry) is Consumer.UNKNOWN:
        err = f"{cmd_name}: command not found\n".encode()
        return None, IOResult(exit_code=127,
                              stderr=err), ExecutionNode(command=cmd_str,
                                                         exit_code=127,
                                                         stderr=err)

    find_expr_tokens: list[str] | None = None
    if cmd_name == "find":
        find_expr_tokens = find_expr_tail(raw_argv)
        try:
            parse_find_expression(find_expr_tokens)
        except FindParseError as exc:
            msg = f"{exc}\n"
            return None, IOResult(exit_code=1,
                                  stderr=msg.encode()), ExecutionNode(
                                      command=cmd_str,
                                      exit_code=1,
                                      stderr=msg.encode())

    if is_cross_mount(cmd_name, path_scopes, registry):
        # Cross-mount execution bypasses a resource command handler. Parse
        # against the shared spec so flags and text operands do not depend on
        # the source mount. The bound single-mount runner lets the strategy
        # runners execute each operand natively on its owning mount.
        cross_parsed = _parse_flags(parts[1:],
                                    SPECS.get(cmd_name),
                                    cmd_name,
                                    session.cwd,
                                    str_flag_paths=True)
        cross_texts = (find_expr_tokens
                       if find_expr_tokens is not None else cross_parsed.texts)
        cross_refusal = _option_error(cmd_name, cross_parsed)
        if cross_refusal is not None:
            refusal_msg, code = cross_refusal
            return None, IOResult(exit_code=code,
                                  stderr=refusal_msg), ExecutionNode(
                                      command=cmd_str,
                                      exit_code=code,
                                      stderr=refusal_msg)
        run_single = functools.partial(run_on_mount,
                                       registry,
                                       session,
                                       dispatch,
                                       namespace,
                                       routing_decision=routing_decision)
        stdout, io = await handle_cross_mount(cmd_name,
                                              path_scopes,
                                              cross_texts,
                                              cross_parsed.flag_kwargs,
                                              dispatch,
                                              run_single,
                                              stdin=stdin)
        if cross_parsed.warnings:
            warn = "".join(f"{cmd_name}: {w}\n"
                           for w in cross_parsed.warnings).encode()
            existing = await materialize(io.stderr) if io.stderr else b""
            io.stderr = warn + existing
        # The native sub-runs carry their own mount's safeguard; the
        # cross-mount command as a whole uses the strictest one across the
        # operand mounts, regardless of which sub-run merged last.
        mounts = []
        for s in path_scopes:
            try:
                mounts.append(registry.mount_for(s.virtual))
            except ValueError:
                # a scope outside any mount contributes nothing here
                pass
        io.safeguard = (resolve_across_mounts(cmd_name, mounts)
                        if mounts else resolve_safeguard(cmd_name))
        stdout = maybe_with_timeout(stdout, io.safeguard, cmd_name)
        return stdout, io, await _exec_node(cmd_str, io, path_scopes)

    # Reject unsupported cross-mount commands
    if len(path_scopes) >= 2:
        mount_prefixes = set()
        for s in path_scopes:
            try:
                mount_prefixes.add(registry.mount_for(s.virtual).prefix)
            except ValueError:
                # a scope outside any mount contributes nothing here
                pass
        if len(mount_prefixes) > 1:
            prefixes_str = ", ".join(sorted(mount_prefixes))
            span_err = (f"{cmd_name}: paths span multiple mounts "
                        f"({prefixes_str}), cross-mount not supported\n")
            return None, IOResult(
                exit_code=1,
                stderr=span_err.encode(),
            ), ExecutionNode(command=cmd_str, exit_code=1)

    try:
        mount = await registry.resolve_mount(cmd_name, path_scopes,
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

    try:
        assert_mount_allowed(mount.prefix)
        for ps in path_scopes:
            target = registry.mount_for(ps.virtual)
            assert_mount_allowed(target.prefix)
    except PermissionError as exc:
        err = f"{cmd_name}: {exc}\n".encode()
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command=cmd_str,
                                                         exit_code=1,
                                                         stderr=err)

    # Parse flags upstream — mount receives clean args
    single_parsed = _parse_flags(parts[1:], mount.spec_for(cmd_name), cmd_name,
                                 session.cwd)
    paths, texts, flag_kwargs, parse_warnings = (single_parsed.paths,
                                                 single_parsed.texts,
                                                 single_parsed.flag_kwargs,
                                                 single_parsed.warnings)
    refusal = _option_error(cmd_name, single_parsed)
    if refusal is not None:
        refusal_msg, code = refusal
        return None, IOResult(exit_code=code,
                              stderr=refusal_msg), ExecutionNode(
                                  command=cmd_str,
                                  exit_code=code,
                                  stderr=refusal_msg)

    if find_expr_tokens is not None:
        texts = find_expr_tokens
        flag_kwargs = _scalar_find_flags(flag_kwargs)

    warn_bytes = ("".join(
        f"{cmd_name}: {w}\n"
        for w in parse_warnings).encode() if parse_warnings else b"")

    if _should_fan_out(cmd_name, paths, flag_kwargs, registry):
        stdout, io, node = await _fan_out_traversal(cmd_name, paths, texts,
                                                    flag_kwargs, registry,
                                                    mount, session.cwd,
                                                    cmd_str, stdin)
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

    if warn_bytes:
        existing = await materialize(io.stderr) if io.stderr else b""
        io.stderr = warn_bytes + existing

    stdout = maybe_with_timeout(stdout, io.safeguard, cmd_name)
    io.stderr = maybe_with_timeout(io.stderr, io.safeguard, cmd_name)

    return stdout, io, await _exec_node(cmd_str, io, paths)


async def _inject_links(
    stdout: ByteSource | None,
    namespace: Namespace,
    paths: list[PathSpec],
    flag_kwargs: dict[str, object],
    cwd: str,
) -> ByteSource | None:
    """Append symlink entries living under the listed directory.

    Links are namespace state, invisible to backend readdir, so ``ls``
    surfaces them the same way child mounts are surfaced. Long form
    renders GNU-style ``name -> target``.

    Args:
        stdout (ByteSource | None): backend ls output.
        namespace (Namespace): addressing authority holding the link table.
        paths (list[PathSpec]): positional ls operands.
        flag_kwargs (dict): parsed ls flags.
        cwd (str): current working directory fallback operand.
    """
    if flag_kwargs.get("d") is True or flag_kwargs.get("R") is True:
        return stdout
    if len(paths) > 1:
        return stdout
    listed = paths[0].virtual if paths else cwd
    links = namespace.links_under(listed)
    if not links:
        return stdout

    existing_bytes = await materialize(stdout) if stdout is not None else b""
    existing = existing_bytes.decode("utf-8")
    long_form = flag_kwargs.get("args_l") is True
    classify = flag_kwargs.get("F") is True
    present: set[str] = set()
    for line in existing.split("\n"):
        if line == "":
            continue
        name = line.split("\t")[-1] if long_form else line.rstrip("/*@|=")
        if name:
            present.add(name)
    extras: list[str] = []
    for name in sorted(links):
        if name in present:
            continue
        if long_form:
            extras.append(f"l\t-\t-\t{name} -> {links[name]}")
        else:
            extras.append(f"{name}@" if classify else name)
    if not extras:
        return stdout
    sep = "" if existing == "" or existing.endswith("\n") else "\n"
    return (existing + sep + "\n".join(extras) + "\n").encode("utf-8")


async def _inject_child_mounts(
    stdout: ByteSource | None,
    registry: MountRegistry,
    paths: list[PathSpec],
    flag_kwargs: dict[str, object],
    cwd: str,
) -> ByteSource | None:
    if flag_kwargs.get("d") is True or flag_kwargs.get("R") is True:
        return stdout
    if len(paths) > 1:
        return stdout
    listed = paths[0].virtual if paths else cwd
    include_hidden = (flag_kwargs.get("a") is True
                      or flag_kwargs.get("A") is True)
    child_names = registry.child_mount_names(listed, include_hidden)
    if not child_names:
        return stdout

    existing_bytes = await materialize(stdout) if stdout is not None else b""
    existing = existing_bytes.decode("utf-8")
    long_form = flag_kwargs.get("args_l") is True
    classify = flag_kwargs.get("F") is True
    present: set[str] = set()
    for line in existing.split("\n"):
        if line == "":
            continue
        if long_form:
            name = line.split("\t")[-1]
        else:
            name = line.rstrip("/*@|=")
        if name:
            present.add(name)
    extras: list[str] = []
    for name in child_names:
        if name in present:
            continue
        if long_form:
            extras.append(f"d\t-\t-\t{name}")
        else:
            extras.append(f"{name}/" if classify else name)
    if not extras:
        return stdout
    sep = "" if existing == "" or existing.endswith("\n") else "\n"
    return (existing + sep + "\n".join(extras)).encode("utf-8")
