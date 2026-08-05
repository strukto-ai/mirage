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

from mirage.commands.cli.builtin.git.errors import OutsideRepositoryError
from mirage.commands.cli.builtin.git.types import RepoLocation


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

    Args:
        location (RepoLocation): the discovered repository.
        start (str): absolute virtual path git is running in.
        operand (str): the operand as the user spelled it.
    """
    absolute = absolute_operand(start, operand)
    root = location.worktree.rstrip("/") or "/"
    if absolute == root:
        return ""
    prefix = root if root.endswith("/") else f"{root}/"
    if not absolute.startswith(prefix):
        raise OutsideRepositoryError(operand, root)
    return absolute[len(prefix):]


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
    """Every path a single operand selects: itself, or a whole subtree.

    Args:
        paths (set[str]): the candidate paths, repository-relative.
        target (str): the operand, repository-relative.
    """
    if target in paths:
        return {target}
    return {path for path in paths if under(path, target)}
