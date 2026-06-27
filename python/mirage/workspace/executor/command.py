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

from collections.abc import Callable
from typing import NamedTuple

from mirage.commands.builtin.find_parse import (FindParseError, find_expr_tail,
                                                parse_find_expression)
from mirage.commands.builtin.generic.crossmount import (handle_cross_mount,
                                                        is_cross_mount)
from mirage.commands.builtin.utils.safeguard import maybe_with_timeout
from mirage.commands.safeguard import resolve_across_mounts, resolve_safeguard
from mirage.commands.spec import (SPECS, OperandKind, flag_kwarg_name,
                                  parse_command, parse_to_kwargs)
from mirage.io import IOResult
from mirage.io.stream import async_chain, materialize, wrap_cachable_streams
from mirage.io.types import ByteSource
from mirage.shell.call_stack import CallStack
from mirage.shell.job_table import JobTable
from mirage.shell.types import ERREXIT_EXEMPT_TYPES
from mirage.types import PathSpec
from mirage.workspace.executor.control import ReturnSignal
from mirage.workspace.executor.fanout import (_fan_out_traversal,
                                              _should_fan_out)
from mirage.workspace.executor.find_action_dispatch import _apply_find_actions
from mirage.workspace.executor.fs_error import format_fs_error
from mirage.workspace.executor.jobs import (handle_jobs, handle_kill,
                                            handle_ps, handle_wait)
from mirage.workspace.mount import MountCommandUnsupported, MountRegistry
from mirage.workspace.session import Session, assert_mount_allowed
from mirage.workspace.types import ExecutionNode

_JOB_BUILTINS = frozenset({"wait", "fg", "kill", "jobs", "ps"})

_FIND_ACTION_FLAGS = frozenset({"delete", "print0", "ls"})


async def _exec_node(cmd_str: str, io: IOResult) -> ExecutionNode:
    """Build the recorded execution node, materializing any streamed stderr.

    Args:
        cmd_str (str): Original command text for the record.
        io (IOResult): Command result whose stderr/exit_code the node carries.
    """
    # The node is a recorded artifact (compared by value, serialized via a
    # sync to_dict, sometimes read twice), so the live lazy io.stderr is
    # materialized to concrete bytes here. On the cross-mount path it is bytes.
    return ExecutionNode(command=cmd_str,
                         stderr=await materialize(io.stderr),
                         exit_code=io.exit_code)


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
        return registry.is_mount_root(p.original)

    if cmd_name == "rm":
        for p in paths:
            if _is_root(p):
                msg = (f"rm: cannot remove '{p.original}': "
                       f"Device or resource busy\n")
                return msg, 1
    elif cmd_name == "mv":
        if _is_root(paths[0]):
            dst = paths[1].original if len(paths) > 1 else "?"
            msg = (f"mv: cannot move '{paths[0].original}' to '{dst}': "
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
                msg = (f"mkdir: cannot create directory '{p.original}': "
                       f"File exists\n")
                return msg, 1
    elif cmd_name == "touch":
        for p in paths:
            if _is_root(p):
                msg = (f"touch: cannot touch '{p.original}': "
                       f"Is a directory\n")
                return msg, 1
    elif cmd_name == "ln":
        if _is_root(paths[-1]):
            msg = (f"ln: failed to create link '{paths[-1].original}': "
                   f"File exists\n")
            return msg, 1
    return None


class _ParsedCommand(NamedTuple):
    paths: list[PathSpec]
    texts: list[str]
    flag_kwargs: dict[str, object]
    warnings: list[str]


def _parse_flags(
    parts: list[str | PathSpec],
    mount: object,
    cmd_name: str,
    cwd: str,
) -> _ParsedCommand:
    """Parse flags from classified parts, recovering PathSpec for PATH values.

    Args:
        parts (list[str | PathSpec]): expanded command words after the
            command name; path-classified words arrive as PathSpec.
        mount (object): mount providing spec_for(cmd_name).
        cmd_name (str): command name used to look up the spec.
        cwd (str): current working directory for relative path resolution.

    Returns:
        _ParsedCommand: positional paths, positional texts, parsed flag dict
        (PATH flag values recovered to PathSpec, repeatable PATH flags to
        list[PathSpec]), and parser warnings (e.g. ignored unknown options).
    """
    # Build string argv and PathSpec lookup
    argv = [
        item.original if isinstance(item, PathSpec) else item for item in parts
    ]
    scope_map: dict[str, PathSpec] = {}
    for item in parts:
        if isinstance(item, PathSpec):
            scope_map[item.original] = item
            stripped = item.original.rstrip("/")
            if stripped and stripped != item.original:
                scope_map[stripped] = item

    spec = mount.spec_for(cmd_name)
    if spec is not None:
        parsed = parse_command(spec, argv, cwd=cwd)
        flag_kwargs = parse_to_kwargs(parsed)

        # Recover PathSpec for PATH flag values; repeatable PATH flags
        # arrive as a list of resolved paths and become list[PathSpec].
        repeat_path_keys = {
            flag_kwarg_name(name)
            for opt in spec.options
            if opt.value_kind == OperandKind.PATH and opt.repeatable
            for name in (opt.short, opt.long) if name
        }
        for key, value in flag_kwargs.items():
            if key in repeat_path_keys and isinstance(value, list):
                flag_kwargs[key] = [
                    scope_map.get(
                        part,
                        PathSpec(original=part,
                                 directory=part[:part.rfind("/") + 1] or "/",
                                 resolved=True)) for part in value
                ]
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
                        original=value,
                        directory=value[:value.rfind("/") + 1] or "/",
                        resolved=True,
                    )
                paths.append(scope)
            else:
                texts.append(value)
        return _ParsedCommand(paths, texts, flag_kwargs, parsed.warnings)

    # No spec: separate by type
    paths = [item for item in parts if isinstance(item, PathSpec)]
    texts = [item for item in parts if not isinstance(item, PathSpec)]
    return _ParsedCommand(paths, texts, {}, [])


async def handle_command(
    execute_node: Callable,
    dispatch: Callable,
    registry: MountRegistry,
    parts: list[str | PathSpec],
    session: Session,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
    job_table: JobTable | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Execute a simple command.

    Parts are already classified: strings for text,
    PathSpec for paths. Dispatches to mount.execute_cmd.
    """
    if not parts:
        return None, IOResult(), ExecutionNode(command="", exit_code=0)

    cmd_name = str(parts[0])
    cmd_str = " ".join(p.original if isinstance(p, PathSpec) else p
                       for p in parts)

    # Job builtins
    if cmd_name in _JOB_BUILTINS and job_table is not None:
        text_parts = [
            p.original if isinstance(p, PathSpec) else p for p in parts
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
        cs = call_stack or CallStack()
        text_args = [
            p.original if isinstance(p, PathSpec) else p for p in parts[1:]
        ]
        cs.push(text_args, function_name=cmd_name)
        saved_locals: dict[str, str | None] = {}
        session._local_vars = saved_locals
        try:
            all_stdout: list = []
            merged_io = IOResult()
            last_exec = ExecutionNode(command=cmd_name, exit_code=0)
            for cmd in func_body:
                try:
                    stdout, io, last_exec = await execute_node(
                        cmd, session, stdin, cs)
                except ReturnSignal as sig:
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
    raw_argv = [
        p.original if isinstance(p, PathSpec) else p for p in parts[1:]
    ]
    early_guard = _check_mount_root_guard_raw(cmd_name, path_scopes, registry,
                                              raw_argv)
    if early_guard is not None:
        msg, code = early_guard
        return None, IOResult(exit_code=code,
                              stderr=msg.encode()), ExecutionNode(
                                  command=cmd_str,
                                  exit_code=code,
                                  stderr=msg.encode())

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
        # the source mount.
        parsed = parse_command(SPECS[cmd_name], raw_argv, cwd=session.cwd)
        stdout, io = await handle_cross_mount(cmd_name, path_scopes,
                                              parsed.texts(),
                                              parse_to_kwargs(parsed),
                                              dispatch)
        if io.safeguard is None:
            mounts = []
            for s in path_scopes:
                try:
                    mounts.append(registry.mount_for(s.original))
                except ValueError:
                    pass
            io.safeguard = (resolve_across_mounts(cmd_name, mounts)
                            if mounts else resolve_safeguard(cmd_name))
        stdout = maybe_with_timeout(stdout, io.safeguard, cmd_name)
        return stdout, io, await _exec_node(cmd_str, io)

    # Reject unsupported cross-mount commands
    if len(path_scopes) >= 2:
        mount_prefixes = set()
        for s in path_scopes:
            try:
                mount_prefixes.add(registry.mount_for(s.original).prefix)
            except ValueError:
                pass
        if len(mount_prefixes) > 1:
            prefixes_str = ", ".join(sorted(mount_prefixes))
            err = (f"{cmd_name}: paths span multiple mounts "
                   f"({prefixes_str}), cross-mount not supported\n")
            return None, IOResult(
                exit_code=1,
                stderr=err.encode(),
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
            target = registry.mount_for(ps.original)
            assert_mount_allowed(target.prefix)
    except PermissionError as exc:
        err = f"{exc}\n".encode()
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command=cmd_str,
                                                         exit_code=1,
                                                         stderr=err)

    # Parse flags upstream — mount receives clean args
    paths, texts, flag_kwargs, parse_warnings = _parse_flags(
        parts[1:], mount, cmd_name, session.cwd)

    if find_expr_tokens is not None:
        texts = find_expr_tokens
        # `repeatable=True` on find value-flags makes parse_to_kwargs emit
        # lists; bespoke backend wrappers read these as scalars. Migrated
        # backends read the expression from `texts` and ignore flag_kwargs.
        flag_kwargs = {
            k: (v[-1] if isinstance(v, list) and v else v)
            for k, v in flag_kwargs.items()
        }

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
        )
    except (FileNotFoundError, NotADirectoryError, IsADirectoryError,
            FileExistsError, PermissionError) as exc:
        err = format_fs_error(cmd_name, exc, paths)
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command=cmd_str,
                                                         exit_code=1,
                                                         stderr=err)

    if cmd_name == "ls" and io.exit_code == 0:
        stdout = await _inject_child_mounts(stdout, registry, paths,
                                            flag_kwargs, session.cwd)

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
    stdout, io = wrap_cachable_streams(stdout, io)

    if warn_bytes:
        existing = await materialize(io.stderr) if io.stderr else b""
        io.stderr = warn_bytes + existing

    stdout = maybe_with_timeout(stdout, io.safeguard, cmd_name)
    io.stderr = maybe_with_timeout(io.stderr, io.safeguard, cmd_name)

    return stdout, io, await _exec_node(cmd_str, io)


async def _inject_child_mounts(
    stdout: ByteSource | None,
    registry: MountRegistry,
    paths: list[PathSpec],
    flag_kwargs: dict,
    cwd: str,
) -> ByteSource | None:
    if flag_kwargs.get("d") is True or flag_kwargs.get("R") is True:
        return stdout
    if len(paths) > 1:
        return stdout
    listed = paths[0].original if paths else cwd
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
