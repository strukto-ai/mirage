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

import posixpath
from collections.abc import Callable

from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.runtime.types import DispatchFn
from mirage.types import FileType, PathSpec
from mirage.utils.path import (MAX_SYMLINK_HOPS, CycleError, resolve_path,
                               resolve_symlinks)
from mirage.workspace.executor.builtins.scope import _scope_path, _to_scope
from mirage.workspace.session import Session
from mirage.workspace.session.shell_dirs import change_dir, logical_cwd
from mirage.workspace.types import ExecutionNode


def _norm(path: str) -> str:
    resolved = posixpath.normpath(path)
    if resolved.startswith("//"):
        resolved = "/" + resolved.lstrip("/")
    return resolved


def _join(path: str, cwd: str) -> str:
    """Join an operand to ``cwd`` **without** simplifying ``..``.

    `resolve_path` normalizes, which is what ``-L`` wants but destroys the
    only input ``-P`` has to work from: bash resolves a link before
    applying the ``..`` that follows it, so `/link/..` is the link's
    parent under ``-L`` and the *target's* parent under ``-P``. Collapsing
    the ``..`` first makes the two modes identical. `_resolve_target`
    normalizes for both modes, so nothing downstream sees the raw form.

    Args:
        path (str): The operand, absolute or relative.
        cwd (str): The directory a relative operand is typed under.

    Returns:
        str: The absolute path, ``..`` and ``.`` segments intact.
    """
    if path.startswith("/"):
        return path
    return cwd.rstrip("/") + "/" + path


def _typed_path(val: str | PathSpec) -> str:
    """The operand as typed, which is what ``-P`` has to resolve.

    A relative operand arrives as a PathSpec whose ``virtual`` was already
    normalized against cwd (`expand/classify/relative.py`), so it has lost
    its ``..`` before ``cd`` is reached. ``raw_path`` keeps the spelling.

    Args:
        val (str | PathSpec): The operand handed to ``cd``.

    Returns:
        str: The typed spelling, or the resolved path when there is none.
    """
    if isinstance(val, PathSpec):
        return val.raw_path or val.virtual
    return val


def _resolve_target(combined: str, links: dict[str, str],
                    physical: bool) -> str:
    """Resolve a combined ``cd`` path, following symlinks per mode.

    Logical (``-L``, default) simplifies ``..`` textually first, then
    follows links. Physical (``-P``) follows links first so ``..`` acts on
    the link target. Both loop resolve<->normalize until stable.

    Args:
        combined (str): The absolute target (cwd joined to arg).
        links (dict[str, str]): The symlink table (link -> target).
        physical (bool): True for ``-P``, False for ``-L``.

    Returns:
        str: The final absolute path with links resolved.

    Raises:
        CycleError: On a symlink loop or unbounded expansion (ELOOP).
    """
    p = combined if physical else _norm(combined)
    for _ in range(MAX_SYMLINK_HOPS):
        n = _norm(resolve_symlinks(p, links))
        if n == p:
            return n
        p = n
    raise CycleError(p)


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
    session: Session,
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
    fallback = _join(raw, cwd)
    cdpath = session.env.get("CDPATH")
    if (not cdpath or not cdpath_target
            or not _cdpath_searchable(cdpath_target)):
        return [(fallback, False)]
    out: list[tuple[str, bool]] = []
    for entry in cdpath.split(":"):
        base = resolve_path(entry, cwd) if entry else cwd
        out.append((_join(cdpath_target, base), entry != ""))
    out.append((fallback, False))
    return out


async def handle_cd(
    dispatch: DispatchFn,
    is_mount_root: Callable[[str], bool],
    path: str | PathSpec,
    session: Session,
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
    candidates = _cd_candidates(_typed_path(path), cdpath_target, session,
                                base)
    error: str | None = None
    for candidate, announce in candidates:
        # The logical name is the candidate with `..` simplified textually
        # and links left alone; the physical one follows them. `-P`
        # collapses the pair, which is why `cd -P .` re-spells the cwd.
        spelled = _norm(candidate)
        logical = spelled
        if table:
            try:
                resolved = _resolve_target(candidate, table, physical)
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
    session: Session,
    resolved: str,
    logical: str,
    spelled: str,
    raw: str,
    print_path: bool,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Land the session on ``resolved`` and print what GNU prints.

    Args:
        session (Session): the session to move.
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
