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

from mirage.types import PathSpec
from mirage.workspace.executor.builtins.dirs.constants import CD_OPTIONS

DirArgs = list[str | PathSpec]


def split_mode_options(
    args: DirArgs, letters: str = CD_OPTIONS, default: bool = False
) -> tuple[DirArgs, str | None, bool]:
    """Split leading ``-L``/``-P`` option flags from the operands.

    Shared by ``cd`` (which also takes ``-e -@``) and ``pwd``, so the
    last-wins rule -- ``pwd -L -P`` is physical, ``pwd -P -L`` logical --
    has one implementation. Accepts clusters such as ``-LP`` plus a
    ``--`` end-of-options marker; a bare ``-`` is an operand (``cd``'s
    OLDPWD shorthand), not an option.

    Args:
        args: The classified arguments after the command name.
        letters: The accepted option characters.
        default: The mode to assume when the line names neither, which
            is what ``set -P`` changes for the whole session.

    Returns:
        ``(operands, bad, physical)`` where ``operands`` are the non-option
        args, ``bad`` is the first unknown option character (or ``None``),
        and ``physical`` is True when ``-P`` is the effective (last-wins)
        mode.
    """
    operands: DirArgs = []
    parsing = True
    physical = default
    for arg in args:
        s = arg.virtual if isinstance(arg, PathSpec) else str(arg)
        if parsing:
            if s == "--":
                parsing = False
                continue
            if s != "-" and len(s) >= 2 and s.startswith("-"):
                bad = next((c for c in s[1:] if c not in letters), None)
                if bad is None:
                    for c in s[1:]:
                        if c == "P":
                            physical = True
                        elif c == "L":
                            physical = False
                    continue
                return operands, bad, physical
            parsing = False
        operands.append(arg)
    return operands, None, physical


def norm(path: str) -> str:
    resolved = posixpath.normpath(path)
    if resolved.startswith("//"):
        resolved = "/" + resolved.lstrip("/")
    return resolved


def join_raw(path: str, cwd: str) -> str:
    """Join an operand to ``cwd`` **without** simplifying ``..``.

    `resolve_path` normalizes, which is what ``-L`` wants but destroys the
    only input ``-P`` has to work from: bash resolves a link before
    applying the ``..`` that follows it, so `/link/..` is the link's
    parent under ``-L`` and the *target's* parent under ``-P``. Collapsing
    the ``..`` first makes the two modes identical. `resolve_target`
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


def typed_path(val: str | PathSpec) -> str:
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


def resolve_target(
    combined: str, follow: Callable[[str], str], physical: bool
) -> str:
    """Resolve a combined ``cd`` path, following symlinks per mode.

    Logical (``-L``, default) simplifies ``..`` textually first, then
    follows links. Physical (``-P``) follows links first so ``..`` acts on
    the link target. The namespace's walk leaves no link in what it
    answers, so one walk settles either.

    Args:
        combined (str): The absolute target (cwd joined to arg).
        follow (Callable[[str], str]): The session's link resolution.
        physical (bool): True for ``-P``, False for ``-L``.

    Returns:
        str: The final absolute path with links resolved.

    Raises:
        CycleError: On a symlink loop or unbounded expansion (ELOOP).
    """
    return norm(follow(combined if physical else norm(combined)))
