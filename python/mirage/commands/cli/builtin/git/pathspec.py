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

import logging
import posixpath
from collections.abc import Mapping, Sequence
from typing import TypeVar

from mirage.commands.cli.builtin.git.errors import (
    EmptyPathspecError,
    OutsideRepositoryError,
    UnsupportedPathspecError,
)
from mirage.commands.cli.builtin.git.types import RepoLocation
from mirage.shell.bytes import byte_view
from mirage.types import PathSpec
from mirage.utils.fnmatch import fnmatch
from mirage.utils.hidden import path_visible
from mirage.utils.path import CycleError

logger = logging.getLogger(__name__)

T = TypeVar("T")

MAGIC = ":"
SLASH = "/"


def absolute_operand(start: str, operand: str) -> str:
    """The virtual path a path operand names.

    Resolved against the directory git was told to run in, not the
    session's, because ``-C`` moves before anything else happens and a
    pathspec is read from where git ended up. Resolving against the
    session cwd instead would make ``git -C /repo add letters.txt``
    reach for a file beside the shell rather than inside the repository.

    Args:
        start (str): absolute virtual path git is running in.
        operand (str): the operand as the user spelled it.
    """
    if operand.startswith("/"):
        return posixpath.normpath(operand)
    return posixpath.normpath(posixpath.join(start, operand))


def repo_relative(location: RepoLocation, start: str, operand: str) -> str:
    """A path operand as a repository-relative path.

    Empty string for the working tree root itself, which is what
    ``git add .`` from the top resolves to and means "everything".
    Git uses the work tree as the base when invoked from outside it,
    as is possible with --git-dir and --work-tree.

    Args:
        location (RepoLocation): the discovered repository.
        start (str): absolute virtual path git is running in.
        operand (str): the operand as the user spelled it.
    """
    root = location.worktree.virtual.rstrip("/") or "/"
    prefix = root if root.endswith("/") else f"{root}/"
    base = start if start == root or start.startswith(prefix) else root
    absolute = absolute_operand(base, operand)
    if absolute == root:
        return ""
    if not absolute.startswith(prefix):
        raise OutsideRepositoryError(operand, root)
    return absolute[len(prefix) :]


def under(path: str, directory: str) -> bool:
    """Whether a repository-relative path sits inside a directory.

    An empty directory is the working tree root, which everything is
    under.

    Args:
        path (str): repository-relative path.
        directory (str): repository-relative directory.
    """
    return not directory or path.startswith(f"{directory}/")


def matched(paths: set[str], target: str) -> set[str]:
    """Every path a single operand selects: itself and its whole subtree.

    Both, not one or the other. A pathspec matches a path that equals it
    and a path it is a leading directory of, and the two are not
    exclusive as soon as the candidates come from more than one tree:
    restoring ``slot`` where the index holds the file ``slot`` and the
    source holds ``slot/child`` has to select both, or the file is
    deleted and the directory never written. git 2.50.1 replaces one
    with the other in either direction.

    Args:
        paths (set[str]): the candidate paths, repository-relative.
        target (str): the operand, repository-relative.
    """
    return {path for path in paths if path == target or under(path, target)}


def pathspec_patterns(
    location: RepoLocation, start: str, operands: Sequence[str]
) -> tuple[str, ...]:
    """Pathspec operands as the repository-relative patterns they name.

    A trailing slash survives, because ``docs/`` names only what lies
    under a directory where ``docs`` also names a file of that name. An
    empty operand is git's own refusal, and magic (``:(top)``, ``:!``)
    is refused as unsupported rather than matched as a path.

    Args:
        location (RepoLocation): the discovered repository.
        start (str): absolute virtual path git is running in.
        operands (Sequence[str]): the pathspecs as typed.
    """
    patterns = []
    for operand in operands:
        if not operand:
            raise EmptyPathspecError()
        if operand.startswith(MAGIC):
            raise UnsupportedPathspecError(operand)
        pattern = repo_relative(location, start, operand)
        if pattern and operand.endswith(SLASH):
            pattern += SLASH
        patterns.append(pattern)
    return tuple(patterns)


def pathspec_selects(
    path: str, patterns: Sequence[str], directory: bool = False
) -> bool:
    """Whether a repository-relative path is one a pathspec names.

    git's default pathspec: a path it spells, a directory the path lies
    under (``docs`` and ``docs/`` both name ``docs/a.md``, only ``docs``
    names a file ``docs``), or a wildcard pattern matching the whole
    path. A wildcard crosses ``/``, so ``*.c`` finds ``sub/x.c``, and
    matches bytes, so ``??.txt`` is what names ``é.txt`` (pinned
    against git 2.54). A tree a diff does not descend into is also named
    by a pathspec inside it, which is how ``diff-tree A -- dir/x``
    prints ``dir``.

    Args:
        path (str): repository-relative path, surrogate-escaped.
        patterns (Sequence[str]): patterns from ``pathspec_patterns``.
        directory (bool): whether the path is a tree left undescended.
    """
    return any(_selects(path, pattern, directory) for pattern in patterns)


def _selects(path: str, pattern: str, directory: bool) -> bool:
    """Whether one pattern names a path; see ``pathspec_selects``.

    Args:
        path (str): repository-relative path, surrogate-escaped.
        pattern (str): one repository-relative pattern.
        directory (bool): whether the path is a tree left undescended.
    """
    stem = pattern.removesuffix(SLASH)
    if under(path, stem) or path == pattern:
        return True
    if directory and (path == stem or under(stem, path)):
        return True
    return fnmatch(byte_view(path), byte_view(pattern))


def visible_path(location: RepoLocation, relative: str) -> bool:
    """Whether a repository entry belongs to the session's visible tree.

    Args:
        location (RepoLocation): repository and its namespace visibility.
        relative (str): Git's repository-relative entry name.
    """
    ns = location.ns
    if ns is None or ns.visibility is None:
        return True
    path = location.worktree.join(relative)
    if not path_visible(ns.visibility, path.virtual):
        return False
    try:
        parent = (
            ns.links.resolve(path.directory) if ns.links else path.directory
        )
    except CycleError as exc:
        logger.debug(
            "Index visibility uses the stored path for a link cycle: %s", exc
        )
        return True
    followed = PathSpec.from_str_path(parent, cwd="/").join(
        posixpath.basename(path.virtual)
    )
    return path_visible(ns.visibility, followed.virtual)


def visible_entries(
    location: RepoLocation, entries: Mapping[bytes, T]
) -> dict[bytes, T]:
    """A session view of Git entries; the persistent mapping stays intact.

    Args:
        location (RepoLocation): repository and the invocation's namespace.
        entries (Mapping[bytes, T]): index or tree entries keyed by Git names.
    """
    return {
        path: entry
        for path, entry in entries.items()
        if visible_path(
            location, path.decode("utf-8", errors="surrogateescape")
        )
    }
