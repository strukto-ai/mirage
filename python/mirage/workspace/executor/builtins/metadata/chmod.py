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

from dataclasses import replace

from mirage.commands.builtin.utils.formatting import ls_mode_string
from mirage.commands.errors import UsageError
from mirage.commands.spec.usage import missing_operand_error
from mirage.runtime.types import DispatchFn
from mirage.shell.bytes import encode_text
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.mode import DEFAULT_DIR_MODE, DEFAULT_FILE_MODE, parse_chmod
from mirage.utils.quote import shell_quote_always
from mirage.workspace.executor.builtins.metadata.metadata import (
    before_recursive_change,
    permission_error,
    preserves_root,
    reference_operands,
    reference_stat,
    resolve_operand,
    root_refusal,
    setattr_via,
    traversal,
    unfollowed_error,
    unread_error,
    verbosity,
    walk_stats,
    walked_name,
)
from mirage.workspace.executor.builtins.shared import (
    expand_operands,
    fail,
    parse_line,
    result,
)
from mirage.workspace.executor.builtins.types import Result
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.session import SessionState


def mode_line(name: str, stat: FileStat, new: int, failed: bool) -> str:
    """chmod's report for one file, worded as GNU chmod 9.7 prints it.

    Args:
        name (str): the file as GNU names it.
        stat (FileStat): the file's stat before the change.
        new (int): the mode asked for.
        failed (bool): whether the backend refused it.
    """
    old = stat.mode if stat.mode is not None else 0
    shown = shell_quote_always(name)
    perms = ls_mode_string(replace(stat, mode=new))[1:]
    if not failed and old == new:
        return f"mode of {shown} retained as {new:04o} ({perms})\n"
    was = ls_mode_string(replace(stat, mode=old))[1:]
    lead = (
        f"failed to change mode of {shown}" if failed else f"mode of {shown}"
    )
    verb = " from" if failed else " changed from"
    return f"{lead}{verb} {old:04o} ({was}) to {new:04o} ({perms})\n"


def link_line(name: str) -> str:
    """chmod -v's report for a link it neither changes nor follows.

    Args:
        name (str): the link as GNU names it.
    """
    shown = shell_quote_always(name)
    return f"neither symbolic link {shown} nor referent has been changed\n"


async def handle_chmod(
    namespace: Namespace,
    dispatch: DispatchFn,
    session: SessionState,
    args: list[str | PathSpec],
) -> Result:
    """chmod MODE FILE...: set permission bits via setattr.

    Follows symlinks (GNU chmod always dereferences). Stored, not
    enforced: mount mode does real access control. ``-R`` walks the
    operand's subtree and applies the mode to every entry, skipping
    symlinks the way GNU does (a traversed link changes neither itself
    nor its referent); a command-line link to a directory is still
    followed and its target walked, unless ``-P`` leaves it, and ``-L``
    follows every link. A refused file is that file's error and the
    rest are still changed; a directory whose listing is refused is
    changed but not descended. ``-v`` reports every file, ``-c`` the
    changed ones, and ``-f`` drops the per-file errors.
    ``--reference`` takes the mode of a file in place of MODE.

    Args:
        namespace (Namespace): addressing authority.
        dispatch (DispatchFn): op dispatcher.
        session (SessionState): session whose cwd resolves operands.
        args (list[str | PathSpec]): args after the command name.
    """
    parsed, fl, refused = parse_line("chmod", args, session.cwd)
    if refused is not None:
        return refused
    links = namespace.session_links(session)
    reference = fl.as_path("reference")
    copied: int | None = None
    operands = parsed.paths
    if reference is not None:
        operands = reference_operands(parsed.texts, parsed.paths, session.cwd)
        if not operands:
            error = missing_operand_error("chmod", None)
            return fail("chmod", f"{error}\n", error.exit_code)
        source = await reference_stat(links, dispatch, "chmod", reference)
        if not isinstance(source, FileStat):
            return source
        copied = (
            source.mode
            if source.mode is not None
            else DEFAULT_DIR_MODE
            if source.type == FileType.DIRECTORY
            else DEFAULT_FILE_MODE
        )
        mode_text = f"{copied:o}"
    elif not parsed.texts or not parsed.paths:
        last = parsed.texts[0] if parsed.texts else None
        error = missing_operand_error("chmod", last)
        return fail("chmod", f"{error}\n", error.exit_code)
    else:
        mode_text = parsed.texts[0]
    if parse_chmod(mode_text, 0) is None:
        return fail("chmod", f"chmod: invalid mode: '{mode_text}'\n", 1)

    report = verbosity(fl)
    walk = traversal(fl, "H")
    recursive = fl.as_bool("recursive")
    errors: list[str] = []
    out: list[str] = []
    for target in await expand_operands(namespace, dispatch, operands):
        if recursive and walk == "P" and links.is_link(target.virtual):
            if report == "verbose":
                out.append(link_line(target.raw_path or target.virtual))
            continue
        found = await resolve_operand(links, dispatch, "chmod", target, errors)
        if found is None:
            if report == "verbose":
                out.append(
                    f"{shell_quote_always(target.raw_path)} could not be "
                    "accessed\n"
                )
            continue
        resolved, stat = found
        if recursive:
            refusal = root_refusal("chmod", fl, target.raw_path, resolved)
            if refusal is not None:
                errors.append(refusal)
                continue
            try:
                await before_recursive_change(
                    links.mounts(False), dispatch, resolved, "chmod"
                )
            except UsageError as exc:
                errors.append(f"{exc}\n")
                continue
            entries = await walk_stats(
                links,
                dispatch,
                resolved,
                stat,
                follow=walk == "L",
                preserve_root=preserves_root(fl),
            )
        else:
            entries = [(resolved, stat, None)]
        for path, path_stat, unread in entries:
            if path_stat.type == FileType.SYMLINK:
                name = walked_name(target.raw_path, resolved, path)
                if walk != "L":
                    if report == "verbose":
                        out.append(link_line(name))
                elif unread is not None:
                    errors.append(unfollowed_error("chmod", name, unread))
                else:
                    top = PathSpec.from_str_path("/")
                    errors.append(root_refusal("chmod", fl, name, top) or "")
                continue
            # Backends without a mode default to what ls renders: 755 for
            # directories, 644 for files (symbolic clauses build on this).
            if path_stat.mode is None:
                path_stat = replace(
                    path_stat,
                    mode=DEFAULT_DIR_MODE
                    if path_stat.type == FileType.DIRECTORY
                    else DEFAULT_FILE_MODE,
                )
            new_mode = parse_chmod(mode_text, path_stat.mode or 0)
            if new_mode is None:
                return fail(
                    "chmod", f"chmod: invalid mode: '{mode_text}'\n", 1
                )
            name = walked_name(target.raw_path, resolved, path)
            failed = False
            try:
                await setattr_via(dispatch, path, mode=new_mode)
            except PermissionError as exc:
                errors.append(
                    permission_error(
                        "chmod", "changing permissions of", name, exc
                    )
                )
                failed = True
            if report == "verbose" or (
                report == "changes"
                and not failed
                and new_mode != path_stat.mode
            ):
                out.append(mode_line(name, path_stat, new_mode, failed))
            if isinstance(unread, PermissionError):
                errors.append(unread_error("chmod", name, unread))
    quiet = fl.as_bool("silent") or fl.as_bool("quiet")
    return result(
        "chmod",
        out=encode_text("".join(out)) or None,
        exit_code=1 if errors else 0,
        stderr=None if quiet else "".join(errors),
    )
