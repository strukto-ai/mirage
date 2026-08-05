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

from typing import Any, Callable

from dulwich.refs import Ref
from dulwich.repo import BaseRepo

from mirage.commands.cli.builtin.git.errors import (  # yapf: disable
    BranchExistsError, BranchNameRequiredError, CheckedOutBranchError,
    GitError, NoBranchError, NoWorkspaceError, UnknownSwitchError)
from mirage.commands.cli.builtin.git.format import short
from mirage.commands.cli.builtin.git.objects import abbrev_for
from mirage.commands.cli.builtin.git.refs import (delete_ref, read_head,
                                                  write_ref)
from mirage.commands.cli.builtin.git.revparse import resolve_commit
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.types import HeadRef, RepoLocation
from mirage.commands.cli.builtin.git.util import HEAD, check_operands, fatal
from mirage.commands.spec.types import FlagView
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.ops.types import MountRoot, StatPath
from mirage.types import PathSpec

HEADS_PREFIX = b"refs/heads/"
REMOTES_PREFIX = b"refs/remotes/"
SYMREF_PREFIX = b"ref: "
CURRENT = "* "
OTHER = "  "
REMOTE = "remotes/"


def _symref_suffix(repo: BaseRepo, ref: bytes) -> str:
    """The ``-> target`` a symbolic ref carries in a branch listing.

    ``refs/remotes/origin/HEAD`` is a pointer, not a branch, and git
    renders it as ``remotes/origin/HEAD -> origin/main``. Empty for an
    ordinary ref.

    Args:
        repo (BaseRepo): repository holding the ref table.
        ref (bytes): full ref name.
    """
    raw = repo.refs.read_loose_ref(Ref(ref))
    if raw is None or not raw.startswith(SYMREF_PREFIX):
        return ""
    target = raw[len(SYMREF_PREFIX):].strip()
    if target.startswith(REMOTES_PREFIX):
        target = target[len(REMOTES_PREFIX):]
    return f" -> {target.decode()}"


async def _create(dispatch: Callable[..., Any], repo: BaseRepo,
                  location: RepoLocation, name: str,
                  start: str | None) -> None:
    """Point a new branch at a commit, refusing to move an existing one.

    Args:
        dispatch (Callable): workspace op dispatcher.
        repo (BaseRepo): the opened repository.
        location (RepoLocation): the discovered repository.
        name (str): the branch name.
        start (str | None): the revision to start it at, HEAD when None.
    """
    ref = f"{HEADS_PREFIX.decode()}{name}"
    if Ref(ref.encode()) in repo.refs.allkeys():
        raise BranchExistsError(name)
    commit = resolve_commit(repo, start or HEAD)
    await write_ref(dispatch, location.commondir, ref, commit.id)


async def _delete(dispatch: Callable[..., Any], repo: BaseRepo,
                  location: RepoLocation, head: HeadRef, name: str) -> bytes:
    """Remove a branch, refusing to remove the one that is checked out.

    Args:
        dispatch (Callable): workspace op dispatcher.
        repo (BaseRepo): the opened repository.
        location (RepoLocation): the discovered repository.
        head (HeadRef): what HEAD points at.
        name (str): the branch name.
    """
    ref = Ref(f"{HEADS_PREFIX.decode()}{name}".encode())
    if ref not in repo.refs.allkeys():
        raise NoBranchError(name)
    if name == head.branch:
        raise CheckedOutBranchError(name, location.worktree)
    sha = repo.refs[ref]
    await delete_ref(dispatch, location.commondir, ref.decode())
    return (f"Deleted branch {name} "
            f"(was {short(sha, abbrev_for(repo))}).\n").encode()


async def branch(
    config: None,
    paths: list[PathSpec],
    *texts: str,
    stat_path: StatPath | None = None,
    mount_root: MountRoot | None = None,
    dispatch: Callable[..., Any] | None = None,
    **flags: object,
) -> tuple[ByteSource | None, IOResult]:
    """List, create or delete branches.

    A name operand creates a branch, ``-d`` deletes one, and neither
    lists them with the checked-out one marked. ``-r`` lists
    remote-tracking branches instead of local ones and ``-a`` lists
    both, which is git's own split; local names sort together and
    remotes follow.

    Args:
        config (None): git declares no config_model.
        paths (list[PathSpec]): path operands.
        stat_path (StatPath | None): dispatcher-backed stat, both
            channels.
        mount_root (MountRoot | None): the mount prefix serving a path.
        dispatch (Callable | None): workspace op dispatcher.
    """
    fl = FlagView(flags)
    remotes_only = fl.as_bool("r")
    include_remotes = remotes_only or fl.as_bool("a")
    try:
        if dispatch is None:
            raise NoWorkspaceError()
        check_operands(texts, UnknownSwitchError)
        repo, location = await opened(fl, stat_path, mount_root, dispatch)
        head = await read_head(dispatch, location.gitdir)
        if fl.as_bool("delete"):
            if not texts:
                raise BranchNameRequiredError()
            deleted = b"".join([
                await _delete(dispatch, repo, location, head, name)
                for name in texts
            ])
            return yield_bytes(deleted), IOResult()
        if texts:
            await _create(dispatch, repo, location, texts[0],
                          texts[1] if len(texts) > 1 else None)
            return None, IOResult()
    except GitError as exc:
        return fatal(exc)
    keys = repo.refs.allkeys()
    lines: list[str] = []
    if not remotes_only:
        for ref in sorted(k for k in keys if k.startswith(HEADS_PREFIX)):
            name = ref[len(HEADS_PREFIX):].decode()
            marker = CURRENT if name == head.branch else OTHER
            lines.append(f"{marker}{name}")
    if include_remotes:
        for ref in sorted(k for k in keys if k.startswith(REMOTES_PREFIX)):
            name = ref[len(REMOTES_PREFIX):].decode()
            lines.append(f"{OTHER}{REMOTE}{name}{_symref_suffix(repo, ref)}")
    if not lines:
        return None, IOResult()
    return yield_bytes(("\n".join(lines) + "\n").encode()), IOResult()
