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

from dulwich.refs import Ref

from mirage.commands.cli.builtin.git.discover import discover
from mirage.commands.cli.builtin.git.errors import (
    InvalidGitFileError,
    NotARepositoryError,
)
from mirage.commands.cli.builtin.git.io import stat_of
from mirage.commands.cli.builtin.git.refs import load_refs, read_head
from mirage.commands.cli.builtin.git.types import RepoLocation
from mirage.types import FileType, PathSpec
from mirage.workspace.files import Files


async def embedded_location(
    vfs: Files, directory: PathSpec
) -> RepoLocation | None:
    """A repository embedded in a work tree, at a directory that holds its
    own ``.git``: None when git could not open one there (no HEAD, objects
    or refs). Mirrors TS ``embeddedLocation``.

    Args:
        vfs (Files): the session's files.
        directory (PathSpec): the directory.
    """
    try:
        found = await discover(vfs, directory)
    except (NotARepositoryError, InvalidGitFileError):
        return None
    if found.worktree.virtual != directory.virtual:
        return None
    for path, kind in (
        (found.gitdir.join("HEAD"), FileType.FILE),
        (found.commondir.join("objects"), FileType.DIRECTORY),
        (found.commondir.join("refs"), FileType.DIRECTORY),
    ):
        info = await stat_of(vfs, path)
        if info is None or info.type is not kind:
            return None
    return replace(found, vfs=vfs)


async def embedded_head(vfs: Files, location: RepoLocation) -> str | None:
    """The commit an embedded repository has checked out, which a gitlink
    records; None on an unborn branch, which git refuses to add. Mirrors
    TS ``embeddedHead``.

    Args:
        vfs (Files): the session's files.
        location (RepoLocation): the embedded repository.
    """
    head = await read_head(vfs, location.gitdir)
    if head.ref is None:
        return head.commit
    refs = await load_refs(vfs, location.gitdir, location.commondir)
    sha = refs.as_dict().get(Ref(head.ref.encode()))
    return None if sha is None else sha.decode()
