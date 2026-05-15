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

import fnmatch
from collections.abc import Callable

from mirage.commands.spec import OperandKind, parse_command, parse_to_kwargs
from mirage.io import IOResult
from mirage.io.stream import async_chain, materialize, wrap_cachable_streams
from mirage.io.types import ByteSource
from mirage.shell.call_stack import CallStack
from mirage.shell.job_table import JobTable
from mirage.shell.types import ERREXIT_EXEMPT_TYPES
from mirage.types import PathSpec
from mirage.workspace.executor.control import ReturnSignal
from mirage.workspace.executor.cross_mount import (handle_cross_mount,
                                                   is_cross_mount)
from mirage.workspace.executor.jobs import (handle_jobs, handle_kill,
                                            handle_ps, handle_wait)
from mirage.workspace.mount import MountRegistry
from mirage.workspace.session import Session, assert_mount_allowed
from mirage.workspace.types import ExecutionNode

_JOB_BUILTINS = frozenset({"wait", "fg", "kill", "jobs", "ps"})

_TRAVERSAL_CMDS = frozenset({"find", "tree", "du"})

_FIND_ACTION_FLAGS = frozenset({"delete", "print0", "ls"})


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


def _path_segments(path: str) -> list[str]:
    return [s for s in path.strip("/").split("/") if s]


def _should_fan_out(
    cmd_name: str,
    paths: list[PathSpec],
    flag_kwargs: dict,
    registry: MountRegistry,
) -> bool:
    """Whether `cmd` on this path should run across multiple mounts.

    True when the command is in the traversal whitelist (find/tree/du)
    and the path has at least one descendant mount; or for grep with
    -r/-R; or for ls -R. Returns False when there's no descendant
    mount under the path (single-mount dispatch is correct).
    """
    if not paths:
        return False
    target = paths[0].original
    if not registry.descendant_mounts(target):
        return False
    if cmd_name in _TRAVERSAL_CMDS:
        return True
    if cmd_name == "grep":
        return (flag_kwargs.get("r") is True or flag_kwargs.get("R") is True
                or flag_kwargs.get("recursive") is True)
    if cmd_name == "ls":
        return flag_kwargs.get("R") is True
    return False


def _adjust_depth_flags(
    flag_kwargs: dict,
    parent_path: str,
    mount_prefix: str,
) -> dict | None:
    """Adjust find's -maxdepth/-mindepth for a fan-out into a child mount.

    Returns the new kwargs dict, or None if the child mount falls
    outside the depth budget (caller should skip it).
    """
    parent_depth = len(_path_segments(parent_path))
    mount_depth = len(_path_segments(mount_prefix))
    delta = mount_depth - parent_depth
    new = dict(flag_kwargs)
    if "maxdepth" in new:
        try:
            md = int(new["maxdepth"]) - delta
        except (TypeError, ValueError):
            md = None
        if md is not None:
            if md < 0:
                return None
            new["maxdepth"] = str(md)
    if "mindepth" in new:
        try:
            mn = max(0, int(new["mindepth"]) - delta)
            new["mindepth"] = str(mn)
        except (TypeError, ValueError):
            pass
    return new


async def _fan_out_traversal(
    cmd_name: str,
    paths: list[PathSpec],
    texts: list[str],
    flag_kwargs: dict,
    registry: MountRegistry,
    primary_mount: object,
    cwd: str,
    cmd_str: str,
    stdin: ByteSource | None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run a traversal command across the parent mount + descendant mounts.

    Each mount runs the command with its own root as the path argument
    (depth flags adjusted for find/tree). Outputs are concatenated in
    mount-prefix-sorted order. The parent mount's output is filtered to
    drop lines that fall under any descendant mount (avoids duplicates
    when the parent's resource has shadowed keys).

    For `find`, mount-prefix paths themselves are injected as synthetic
    directory entries (subject to depth and -type filters) because
    mirage's per-mount find doesn't emit the path argument itself.
    """
    target_path = paths[0].original
    descendants = registry.descendant_mounts(target_path)
    descendant_prefixes = [m.prefix.rstrip("/") for m in descendants]

    all_stdout: list[bytes] = []
    merged_io = IOResult()
    final_exit = 0
    success_seen = False

    for mount in [primary_mount] + list(descendants):
        if mount is primary_mount:
            sub_paths = list(paths)
            sub_flags = dict(flag_kwargs)
        else:
            mount_root = mount.prefix.rstrip("/") or "/"
            sub_flags = _adjust_depth_flags(flag_kwargs, target_path,
                                            mount.prefix)
            if sub_flags is None:
                continue
            sub_paths = [
                PathSpec(original=mount_root,
                         directory=mount_root,
                         resolved=True)
            ]
        try:
            stdout, io = await mount.execute_cmd(cmd_name,
                                                 sub_paths,
                                                 list(texts),
                                                 sub_flags,
                                                 stdin=stdin,
                                                 cwd=cwd)
        except Exception:
            continue

        if mount is primary_mount and descendant_prefixes and stdout:
            stdout = await _filter_under_prefixes(stdout, descendant_prefixes)

        if stdout is not None:
            data = await materialize(stdout)
            if data:
                all_stdout.append(data)
        if io.exit_code == 0:
            success_seen = True
        elif io.exit_code != 0 and final_exit == 0:
            final_exit = io.exit_code
        merged_io = await merged_io.merge(io)

    if cmd_name == "find":
        synthetic = _synthesize_find_mount_entries(target_path, descendants,
                                                   flag_kwargs)
        if synthetic:
            all_stdout.append(synthetic.encode("utf-8"))

    combined: ByteSource | None
    if all_stdout:
        combined = b"\n".join(b.rstrip(b"\n") for b in all_stdout) + b"\n"
    else:
        combined = None
    final_io_exit = 0 if success_seen else final_exit

    if cmd_name == "find":
        combined, action_err = await _apply_find_actions(
            combined, flag_kwargs, registry, cwd)
        if action_err:
            existing = (await materialize(merged_io.stderr)
                        if merged_io.stderr else b"")
            merged_io.stderr = existing + action_err
            if final_io_exit == 0:
                final_io_exit = 1

    merged_io.exit_code = final_io_exit
    exec_node = ExecutionNode(command=cmd_str,
                              exit_code=final_io_exit,
                              stderr=merged_io.stderr)
    return combined, merged_io, exec_node


def _synthesize_find_mount_entries(
    target_path: str,
    descendants: list,
    flag_kwargs: dict,
) -> str:
    """Return synthetic find lines for descendant mount roots.

    `find /` and friends should list mount prefixes as directory
    entries even though no per-mount find emits its own root. Honors
    -maxdepth / -mindepth windows and the -type filter (only injects
    when 'd' or no type filter is set).
    """
    type_filter = flag_kwargs.get("type")
    if type_filter is not None and type_filter != "d":
        return ""
    parent_depth = len(_path_segments(target_path))
    try:
        max_depth = (int(flag_kwargs["maxdepth"])
                     if "maxdepth" in flag_kwargs else None)
    except (TypeError, ValueError):
        max_depth = None
    try:
        min_depth = (int(flag_kwargs["mindepth"])
                     if "mindepth" in flag_kwargs else 0)
    except (TypeError, ValueError):
        min_depth = 0
    name_pat = flag_kwargs.get("name")
    iname_pat = flag_kwargs.get("iname")
    out: list[str] = []
    for m in descendants:
        prefix_no_slash = m.prefix.rstrip("/")
        depth = len(_path_segments(prefix_no_slash)) - parent_depth
        if depth < min_depth:
            continue
        if max_depth is not None and depth > max_depth:
            continue
        base = prefix_no_slash.rsplit("/", 1)[-1] or prefix_no_slash
        if isinstance(name_pat, str) and not fnmatch.fnmatch(base, name_pat):
            continue
        if isinstance(iname_pat, str) and not fnmatch.fnmatch(
                base.lower(), iname_pat.lower()):
            continue
        out.append(prefix_no_slash)
    return "\n".join(out)


async def _filter_under_prefixes(
    stdout: ByteSource,
    descendant_prefixes: list[str],
) -> bytes:
    """Drop lines whose path falls under any descendant mount prefix.

    Path is taken from the start of the line up to the first tab,
    colon, or whitespace (handles find / du / grep output formats).
    Lines that do not start with `/` are passed through.
    """
    data = await materialize(stdout)
    text = data.decode("utf-8", errors="replace")
    out_lines: list[str] = []
    for line in text.split("\n"):
        if line == "":
            continue
        path = line
        for sep in ("\t", ":"):
            if sep in path:
                path = path.split(sep, 1)[0]
                break
        if path.startswith("/"):
            shadowed = False
            for pre in descendant_prefixes:
                if path == pre or path.startswith(pre + "/"):
                    shadowed = True
                    break
            if shadowed:
                continue
        out_lines.append(line)
    return ("\n".join(out_lines) + "\n").encode("utf-8") if out_lines else b""


async def _apply_find_actions(
    stdout: ByteSource | None,
    flag_kwargs: dict,
    registry: MountRegistry,
    cwd: str,
) -> tuple[ByteSource | None, bytes]:
    """Apply find action flags (-delete / -print0 / -ls) to find output.

    Per-resource find handlers only emit matched paths. This dispatcher
    layer reads action flags and dispatches the side effect (rm for
    -delete, ls -ld for -ls) per match through the appropriate mount,
    then re-formats the output.

    Args:
        stdout (ByteSource | None): newline-joined match list from find.
        flag_kwargs (dict): parsed flag dict; action flags read here.
        registry (MountRegistry): used to route per-match dispatch.
        cwd (str): cwd forwarded to per-match sub-dispatch.
    """
    has_delete = flag_kwargs.get("delete") is True
    has_print0 = flag_kwargs.get("print0") is True
    has_ls = flag_kwargs.get("ls") is True
    has_print = flag_kwargs.get("print") is True

    if not (has_delete or has_print0 or has_ls):
        return stdout, b""
    if stdout is None:
        return stdout, b""

    text = (await materialize(stdout)).decode("utf-8", errors="replace")
    matches = [p for p in text.split("\n") if p]
    errors: list[bytes] = []

    if has_delete:
        # Deepest-first so children are removed before parents.
        # Skip mount roots: mount points are structural, not
        # unlinkable entries — refusing matches Unix semantics.
        deletable = [p for p in matches if not registry.is_mount_root(p)]
        ordered = sorted(deletable, key=lambda p: p.count("/"), reverse=True)
        for path in ordered:
            try:
                mount = registry.mount_for(path)
            except ValueError:
                msg = f"find: cannot delete '{path}': no mount\n"
                errors.append(msg.encode())
                continue
            ps = PathSpec(
                original=path,
                directory=path[:path.rfind("/") + 1] or "/",
                resolved=True,
            )
            try:
                _, rm_io = await mount.execute_cmd("rm", [ps], [], {},
                                                   stdin=None,
                                                   cwd=cwd)
            except (FileNotFoundError, NotADirectoryError, PermissionError,
                    ValueError) as exc:
                errors.append(
                    f"find: cannot delete '{path}': {exc}\n".encode())
                continue
            if rm_io.exit_code != 0:
                err = await materialize(rm_io.stderr) if rm_io.stderr else b""
                if not err:
                    err = f"find: cannot delete '{path}'\n".encode()
                errors.append(err)
        # GNU find: -delete suppresses default print unless -print also set.
        output_matches = matches if has_print else []
    elif has_ls:
        output_matches = []
        for path in matches:
            try:
                mount = registry.mount_for(path)
            except ValueError:
                errors.append(f"find: cannot ls '{path}': no mount\n".encode())
                continue
            ps = PathSpec(
                original=path,
                directory=path[:path.rfind("/") + 1] or "/",
                resolved=True,
            )
            try:
                ls_out, _ = await mount.execute_cmd("ls", [ps], [], {
                    "args_l": True,
                    "d": True
                },
                                                    stdin=None,
                                                    cwd=cwd)
            except (FileNotFoundError, NotADirectoryError, PermissionError,
                    ValueError) as exc:
                errors.append(f"find: cannot ls '{path}': {exc}\n".encode())
                continue
            if ls_out is not None:
                line = (await materialize(ls_out)).decode(
                    "utf-8", errors="replace").rstrip("\n")
                if line:
                    output_matches.append(line)
    else:
        output_matches = matches

    err_blob = b"".join(errors)
    if not output_matches:
        return None, err_blob

    if has_print0:
        body = b"\x00".join(m.encode("utf-8")
                            for m in output_matches) + b"\x00"
    else:
        body = ("\n".join(output_matches) + "\n").encode("utf-8")
    return body, err_blob


def _parse_flags(
    parts: list[str | PathSpec],
    mount: object,
    cmd_name: str,
    cwd: str,
) -> tuple[list[PathSpec], list[str], dict]:
    """Parse flags from classified parts, recovering PathSpec for PATH values.

    Returns:
        (paths, texts, flag_kwargs) — positional paths, positional texts,
        and parsed flag dict with PathSpec for PATH flag values.
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
            if stripped != item.original:
                scope_map[stripped] = item

    spec = mount.spec_for(cmd_name)
    if spec is not None:
        parsed = parse_command(spec, argv, cwd=cwd)
        flag_kwargs = parse_to_kwargs(parsed)

        # Recover PathSpec for PATH flag values
        for key, value in flag_kwargs.items():
            if isinstance(value, str) and value in scope_map:
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
        return paths, texts, flag_kwargs

    # No spec: separate by type
    paths = [item for item in parts if isinstance(item, PathSpec)]
    texts = [item for item in parts if not isinstance(item, PathSpec)]
    return paths, texts, {}


async def handle_command(
    execute_node: Callable,
    dispatch: Callable,
    registry: MountRegistry,
    parts: list[str | PathSpec],
    session: Session,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
    job_table: JobTable | None = None,
    history: object = None,
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
    text_only = [
        p.original if isinstance(p, PathSpec) else p for p in parts[1:]
    ]

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

    if is_cross_mount(cmd_name, path_scopes, registry):
        return await handle_cross_mount(cmd_name, path_scopes, text_only,
                                        dispatch, cmd_str)

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

    mount = await registry.resolve_mount(cmd_name, path_scopes, session.cwd)
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
    paths, texts, flag_kwargs = _parse_flags(parts[1:], mount, cmd_name,
                                             session.cwd)

    if _should_fan_out(cmd_name, paths, flag_kwargs, registry):
        return await _fan_out_traversal(cmd_name, paths, texts, flag_kwargs,
                                        registry, mount, session.cwd, cmd_str,
                                        stdin)

    try:
        stdout, io = await mount.execute_cmd(
            cmd_name,
            paths,
            texts,
            flag_kwargs,
            stdin=stdin,
            cwd=session.cwd,
            dispatch=dispatch,
            history=history,
            session_id=session.session_id,
            env=session.env,
            exec_allowed=registry.is_exec_allowed(),
        )
    except (FileNotFoundError, NotADirectoryError, PermissionError) as exc:
        err = f"{cmd_name}: {exc}\n".encode()
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
    if prefix and mount is not registry.default_mount:
        io.reads = {prefix + k: v for k, v in io.reads.items()}
        io.writes = {prefix + k: v for k, v in io.writes.items()}
        io.cache = [prefix + p for p in io.cache]
    stdout, io = wrap_cachable_streams(stdout, io)

    stderr_bytes = await materialize(io.stderr)
    exec_node = ExecutionNode(command=cmd_str,
                              stderr=stderr_bytes,
                              exit_code=io.exit_code)
    return stdout, io, exec_node


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
