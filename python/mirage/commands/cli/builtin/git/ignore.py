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
from io import BytesIO
from typing import BinaryIO, cast

from dulwich.ignore import IgnoreFilter, read_ignore_patterns

from mirage.commands.cli.builtin.git.io import read_optional
from mirage.runtime.types import DispatchFn

GITIGNORE = ".gitignore"
INFO_EXCLUDE = "info/exclude"


def _relative(prefix: str, path: str) -> str:
    """Spell a repository-relative path relative to a filter's directory.

    A ``.gitignore`` names paths from its own directory down, so the same
    path is a different string to each filter on the stack.

    Args:
        prefix (str): the filter's directory, repository-relative, empty
            at the root.
        path (str): repository-relative path being tested.
    """
    return path[len(prefix) + 1:] if prefix else path


class IgnoreStack:
    """The ``.gitignore`` files governing one directory, innermost last.

    Immutable, and pushed rather than mutated, so a walk hands each
    subdirectory its own stack and cannot forget to pop one on the way
    back up.

    Precedence runs the opposite way to the list: a deeper file wins
    over a shallower one, so the search runs from the end. Within one
    file the last matching pattern wins, which is what ``IgnoreFilter``
    already does, and is how a ``!`` line un-ignores something the lines
    above it caught.

    Args:
        filters (list[tuple[str, IgnoreFilter]]): each directory prefix
            and the filter parsed from the file it holds.
    """

    def __init__(self, filters: list[tuple[str, IgnoreFilter]]) -> None:
        self._filters = filters

    def push(self, prefix: str, patterns: bytes) -> "IgnoreStack":
        """A new stack with one more ``.gitignore`` on top.

        Args:
            prefix (str): the directory the file was found in,
                repository-relative.
            patterns (bytes): the file's contents.
        """
        parsed = list(read_ignore_patterns(cast(BinaryIO, BytesIO(patterns))))
        return IgnoreStack(self._filters + [(prefix, IgnoreFilter(parsed))])

    def is_ignored(self, path: str, is_dir: bool = False) -> bool:
        """Whether git would leave a path out of an untracked listing.

        Args:
            path (str): repository-relative path.
            is_dir (bool): whether the path names a directory, which
                decides whether a ``build/`` pattern can match it.
        """
        spelled = f"{path}/" if is_dir else path
        for prefix, ignore_filter in reversed(self._filters):
            verdict = ignore_filter.is_ignored(_relative(prefix, spelled))
            if verdict is not None:
                return verdict
        return False


async def load_ignores(dispatch: DispatchFn, gitdir: str,
                       worktree: str) -> IgnoreStack:
    """The root of the ignore stack: the repository's own two files.

    ``.git/info/exclude`` sits below the root ``.gitignore`` because it
    is the repository's private list and a tracked ``.gitignore`` should
    be able to override it.

    ``core.excludesFile``, the per-user global list, is deliberately not
    read. It names a path on whichever machine git ran on, and a mount
    has no way to reach that machine's home directory; honoring it would
    mean reading the operator's own file and applying it to somebody
    else's repository.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        gitdir (str): absolute virtual path of the git directory.
        worktree (str): absolute virtual path of the working tree root.
    """
    stack = IgnoreStack([])
    private = await read_optional(dispatch,
                                  posixpath.join(gitdir, INFO_EXCLUDE))
    if private is not None:
        stack = stack.push("", private)
    root = await read_optional(dispatch, posixpath.join(worktree, GITIGNORE))
    if root is not None:
        stack = stack.push("", root)
    return stack
