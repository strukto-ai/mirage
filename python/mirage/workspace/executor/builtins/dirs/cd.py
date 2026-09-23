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

from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.runtime.types import DispatchFn
from mirage.types import FileType, PathSpec
from mirage.utils.path import CycleError, resolve_path
from mirage.workspace.executor.builtins.dirs.constants import CD_USAGE
from mirage.workspace.executor.builtins.dirs.dirs import (join_raw, norm,
                                                          resolve_target,
                                                          split_mode_options,
                                                          typed_path)
from mirage.workspace.executor.builtins.scope import _scope_path, _to_scope
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.expand.classify import classify_bare_path
from mirage.workspace.session import SessionState
from mirage.workspace.session.shell_dirs import (change_dir, home_dir,
                                                 logical_cwd)
from mirage.workspace.types import ExecutionNode


def _cdpath_searchable(target: str) -> bool:
    """Return whether ``target`` triggers a ``$CDPATH`` search.

    Args:
        target: The as-typed ``cd`` operand.

    Returns:
        True when ``target`` is relative and does not begin with ``./``
        or ``../`` (mirroring GNU bash's ``cd`` search rule).
    """
    if target.startswith(("/", "./", "../")):
        return False
    return target not in (".", "..")


def _cd_candidates(
    raw: str,
    cdpath_target: str | None,
    session: SessionState,
    cwd: str,
) -> list[tuple[str, bool]]:
    """Build the ordered list of directories ``cd`` should try.

    Args:
        raw: The resolved operand path string.
        cdpath_target: The as-typed operand when a ``$CDPATH`` search
            applies, else ``None``.
        session: The shell session (provides env).
        cwd: The directory a relative operand joins to -- the logical cwd
            under ``-L``, the physical one under ``-P``.

    Returns:
        ``(resolved_path, announce)`` pairs in trial order; ``announce``
        marks a non-empty ``$CDPATH`` hit whose absolute path GNU prints.
    """
    fallback = join_raw(raw, cwd)
    cdpath = session.env.get("CDPATH")
    if (not cdpath or not cdpath_target
            or not _cdpath_searchable(cdpath_target)):
        return [(fallback, False)]
    out: list[tuple[str, bool]] = []
    for entry in cdpath.split(":"):
        base = resolve_path(entry, cwd) if entry else cwd
        out.append((join_raw(cdpath_target, base), entry != ""))
    out.append((fallback, False))
    return out


async def handle_cd(
    dispatch: DispatchFn,
    is_mount_root: Callable[[str], bool],
    path: str | PathSpec,
    session: SessionState,
    print_path: bool = False,
    cdpath_target: str | None = None,
    links: dict[str, str] | None = None,
    physical: bool = False,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    raw = _scope_path(path)
    table = links or {}
    # `-L` joins a relative operand to the name the shell is *spelling*,
    # `-P` to the one it resolves to: from a logical /data/lk whose target
    # is /data/deep/real, bash sends `cd -L ..` to /data and `cd -P ..` to
    # /data/deep.
    base = session.cwd if physical else logical_cwd(session)
    candidates = _cd_candidates(typed_path(path), cdpath_target, session, base)
    error: str | None = None
    for candidate, announce in candidates:
        # The logical name is the candidate with `..` simplified textually
        # and links left alone; the physical one follows them. `-P`
        # collapses the pair, which is why `cd -P .` re-spells the cwd.
        spelled = norm(candidate)
        logical = spelled
        if table:
            try:
                resolved = resolve_target(candidate, table, physical)
            except CycleError:
                error = f"cd: {raw}: Too many levels of symbolic links\n"
                continue
        else:
            resolved = logical
        if physical:
            logical = resolved
        if resolved == "/":
            return _cd_success(session, "/", logical, spelled, raw, print_path
                               or announce)
        scope = _to_scope(resolved)
        s = None
        not_found = False
        try:
            s, _ = await dispatch("stat", scope)
        except FileNotFoundError:
            not_found = True
        except ValueError as exc:
            error = f"cd: {raw}: {exc}\n"
            continue
        if s is None or not_found:
            if is_mount_root(resolved):
                return _cd_success(session, resolved, logical, spelled, raw,
                                   print_path or announce)
            error = f"cd: {raw}: No such file or directory\n"
            continue
        if s.type != FileType.DIRECTORY:
            error = f"cd: {raw}: Not a directory\n"
            continue
        return _cd_success(session, resolved, logical, spelled, raw, print_path
                           or announce)
    err = (error or f"cd: {raw}: No such file or directory\n").encode()
    return None, IOResult(exit_code=1,
                          stderr=err), ExecutionNode(command=f"cd {raw}",
                                                     exit_code=1,
                                                     stderr=err)


def _cd_success(
    session: SessionState,
    resolved: str,
    logical: str,
    spelled: str,
    raw: str,
    print_path: bool,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Land the session on ``resolved`` and print what GNU prints.

    Args:
        session (SessionState): the session to move.
        resolved (str): the physical directory to land on.
        logical (str): the name to remember as the cwd's spelling --
            ``resolved`` under ``-P``, which collapses the pair.
        spelled (str): the path as selected, ``..`` simplified but links
            intact. What GNU announces, and NOT the same as ``logical``
            under ``-P``: ``cd -P -`` prints /tmp/lk and then lands on
            /tmp/deep/real, and a ``-P`` ``$CDPATH`` hit prints
            /opt/c/lnk while landing on /opt/c/t.
        raw (str): the operand as typed, for the history node.
        print_path (bool): whether GNU announces this move at all.
    """
    change_dir(session, resolved, logical)
    out = (spelled + "\n").encode() if print_path else None
    return out, IOResult(), ExecutionNode(command=f"cd {raw}", exit_code=0)


async def cd_builtin(call: BuiltinCall) -> Result:
    """The ``cd`` arm: split ``-L``/``-P``, pick the target, then move.

    ``set -P`` (``set -o physical``) is the session-wide version of the
    per-command flag, and GNU applies it to both ``cd`` and ``pwd``.

    Args:
        call (BuiltinCall): the invocation.
    """
    session = call.session
    dispatch = call.dispatch
    registry = call.registry
    namespace = call.namespace
    shell_physical = bool(session.shell_options.get("physical"))
    cd_operands, bad_opt, physical = split_mode_options(list(
        call.argv.operands),
                                                        default=shell_physical)
    if bad_opt is not None:
        err = f"cd: -{bad_opt}: invalid option\n{CD_USAGE}".encode()
        return None, IOResult(exit_code=2,
                              stderr=err), ExecutionNode(command="cd",
                                                         exit_code=2,
                                                         stderr=err)
    if len(cd_operands) > 1:
        err = b"cd: too many arguments\n"
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="cd",
                                                         exit_code=1,
                                                         stderr=err)
    if not cd_operands:
        home = home_dir(session)
        if home is None:
            err = b"cd: HOME not set\n"
            return None, IOResult(exit_code=1,
                                  stderr=err), ExecutionNode(command="cd",
                                                             exit_code=1,
                                                             stderr=err)
        return await handle_cd(dispatch,
                               registry.is_mount_root,
                               home,
                               session,
                               links=namespace.symlink_targets(),
                               physical=physical)
    raw = cd_operands[0]
    raw_str = raw.virtual if isinstance(raw, PathSpec) else str(raw)
    if raw_str == "-":
        old = session.env.get("OLDPWD")
        if not old:
            err = b"cd: OLDPWD not set\n"
            return None, IOResult(exit_code=1,
                                  stderr=err), ExecutionNode(command="cd -",
                                                             exit_code=1,
                                                             stderr=err)
        return await handle_cd(dispatch,
                               registry.is_mount_root,
                               old,
                               session,
                               print_path=True,
                               links=namespace.symlink_targets(),
                               physical=physical)
    path: str | PathSpec
    if isinstance(raw, PathSpec):
        path = raw
        cdpath_target = raw.raw_path
    elif raw_str.startswith("/"):
        path = raw_str
        cdpath_target = raw_str
    else:
        path = classify_bare_path(raw_str, registry, session.cwd)
        cdpath_target = raw_str
    return await handle_cd(dispatch,
                           registry.is_mount_root,
                           path,
                           session,
                           cdpath_target=cdpath_target,
                           links=namespace.symlink_targets(),
                           physical=physical)
