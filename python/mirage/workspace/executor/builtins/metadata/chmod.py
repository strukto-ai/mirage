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

from mirage.commands.builtin.utils.formatting import ls_mode_string
from mirage.commands.spec.usage import missing_operand_error
from mirage.runtime.types import DispatchFn
from mirage.shell.bytes import encode_text
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.mode import DEFAULT_DIR_MODE, DEFAULT_FILE_MODE, parse_chmod
from mirage.utils.quote import shell_quote_always
from mirage.workspace.executor.builtins.metadata.metadata import (
    apply_attrs,
    resolve_operand,
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
    """chmod's report for one file (GNU chmod 9.7's describe_change).

    Args:
        name (str): the file as GNU names it.
        stat (FileStat): the file's stat before the change.
        new (int): the mode asked for.
        failed (bool): whether the backend refused it.
    """
    old = stat.mode if stat.mode is not None else 0
    shown = shell_quote_always(name)
    perms = ls_mode_string(stat.model_copy(update={"mode": new}))[1:]
    if not failed and old == new:
        return f"mode of {shown} retained as {new:04o} ({perms})\n"
    was = ls_mode_string(stat.model_copy(update={"mode": old}))[1:]
    lead = (
        f"failed to change mode of {shown}" if failed else f"mode of {shown}"
    )
    verb = " from" if failed else " changed from"
    return f"{lead}{verb} {old:04o} ({was}) to {new:04o} ({perms})\n"


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
    followed and its target walked. ``-v`` reports every file, ``-c``
    the changed ones, and ``-f`` drops the per-file errors.

    Args:
        namespace (Namespace): addressing authority.
        dispatch (DispatchFn): op dispatcher.
        session (SessionState): session whose cwd resolves operands.
        args (list[str | PathSpec]): args after the command name.
    """
    parsed, fl, refused = parse_line("chmod", args, session.cwd)
    if refused is not None:
        return refused
    if not parsed.texts or not parsed.paths:
        last = parsed.texts[0] if parsed.texts else None
        error = missing_operand_error("chmod", last)
        return fail("chmod", f"{error}\n", error.exit_code)
    mode_text = parsed.texts[0]
    if parse_chmod(mode_text, 0) is None:
        return fail("chmod", f"chmod: invalid mode: '{mode_text}'\n", 1)

    report = verbosity(fl)
    errors: list[str] = []
    out: list[str] = []
    for target in await expand_operands(namespace, parsed.paths):
        found = await resolve_operand(
            namespace, dispatch, "chmod", target, errors
        )
        if found is None:
            if report == "verbose":
                out.append(
                    f"{shell_quote_always(target.raw_path)} could not be "
                    "accessed\n"
                )
            continue
        resolved, stat = found
        if fl.as_bool("recursive"):
            entries = await walk_stats(namespace, dispatch, resolved, stat)
        else:
            entries = [(resolved, stat)]
        for path, path_stat in entries:
            # Backends without a mode default to what ls renders: 755 for
            # directories, 644 for files (symbolic clauses build on this).
            if path_stat.mode is None:
                path_stat = path_stat.model_copy(
                    update={
                        "mode": DEFAULT_DIR_MODE
                        if path_stat.type == FileType.DIRECTORY
                        else DEFAULT_FILE_MODE
                    }
                )
            new_mode = parse_chmod(mode_text, path_stat.mode or 0)
            if new_mode is None:
                return fail(
                    "chmod", f"chmod: invalid mode: '{mode_text}'\n", 1
                )
            before = len(errors)
            await apply_attrs(dispatch, "chmod", path, errors, mode=new_mode)
            failed = len(errors) > before
            if report == "verbose" or (
                report == "changes"
                and not failed
                and new_mode != path_stat.mode
            ):
                name = walked_name(target.raw_path, resolved, path)
                out.append(mode_line(name, path_stat, new_mode, failed))
    quiet = fl.as_bool("silent") or fl.as_bool("quiet")
    return result(
        "chmod",
        out=encode_text("".join(out)) or None,
        exit_code=1 if errors else 0,
        stderr=None if quiet else "".join(errors),
    )
