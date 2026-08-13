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

import asyncio

from dulwich.objects import ObjectID
from dulwich.refs import Ref
from dulwich.repo import BaseRepo
from dulwich.walk import Walker

from mirage.commands.cli.builtin.git.errors import (  # yapf: disable
    BranchExistsError, BranchNameRequiredError, CheckedOutBranchError,
    GitError, NoBranchError, NoWorkspaceError, UnknownSwitchError,
    UnmergedBranchError)
from mirage.commands.cli.builtin.git.format import short
from mirage.commands.cli.builtin.git.objects import abbrev_for
from mirage.commands.cli.builtin.git.refs import (delete_ref, read_head,
                                                  write_ref)
from mirage.commands.cli.builtin.git.revparse import resolve_commit
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.types import HeadRef, RepoLocation
from mirage.commands.cli.builtin.git.util import HEAD, check_operands, fatal
from mirage.commands.cli.types import CLIInvocation, CLIVerbOpts
from mirage.commands.spec.types import FlagView
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.runtime.types import DispatchFn

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


async def _create(dispatch: DispatchFn, repo: BaseRepo, location: RepoLocation,
                  name: str, start: str | None) -> None:
    """Point a new branch at a commit, refusing to move an existing one.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
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


def _head_commit(repo: BaseRepo, head: HeadRef) -> bytes | None:
    """The commit HEAD resolves to, None on an unborn branch.

    HEAD carries an object id only when detached; attached it names a
    ref, which is unset until the first commit.

    Args:
        repo (BaseRepo): the opened repository.
        head (HeadRef): what HEAD points at.
    """
    if head.commit is not None:
        return head.commit.encode()
    if head.ref is None:
        return None
    ref = Ref(head.ref.encode())
    return repo.refs[ref] if ref in repo.refs.allkeys() else None


def _merged(repo: BaseRepo, sha: bytes, head: bytes | None) -> bool:
    """Whether HEAD already holds every commit a branch points at.

    Synchronous, and called on a worker thread: walking ancestry pulls
    commit objects through the dispatcher. The walk stops at the first
    sighting, so a merged branch costs only as much history as separates
    it from HEAD; only a negative answer walks the whole thing, which is
    what any repository without a commit graph pays.

    An unborn HEAD holds nothing, which is git's answer too: on an
    orphan branch every other branch reads as unmerged.

    ``dulwich.graph.can_fast_forward`` answers exactly this question and
    cannot be used: it asks the repository for its grafts and shallow
    boundary, and a bare ``BaseRepo`` raises rather than answering.
    ``Walker`` is what ``log`` already walks with, and it needs only the
    object store.

    Only HEAD is consulted. git also accepts a branch contained in its
    own upstream, and there are no remotes here to have one.

    Args:
        repo (BaseRepo): the opened repository.
        sha (bytes): the branch tip.
        head (bytes | None): the commit HEAD resolves to.
    """
    if head is None:
        return False
    if sha == head:
        return True
    return any(entry.commit.id == sha
               for entry in Walker(repo.object_store, [ObjectID(head)]))


async def _delete(dispatch: DispatchFn, repo: BaseRepo, location: RepoLocation,
                  head: HeadRef, name: str, force: bool) -> bytes:
    """Remove a branch, refusing when the removal would lose commits.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        repo (BaseRepo): the opened repository.
        location (RepoLocation): the discovered repository.
        head (HeadRef): what HEAD points at.
        name (str): the branch name.
        force (bool): whether ``-D`` was given, which deletes a branch
            HEAD does not contain.
    """
    ref = Ref(f"{HEADS_PREFIX.decode()}{name}".encode())
    if ref not in repo.refs.allkeys():
        raise NoBranchError(name)
    if name == head.branch:
        raise CheckedOutBranchError(name, location.worktree)
    sha = repo.refs[ref]
    if not force and not await asyncio.to_thread(_merged, repo, sha,
                                                 _head_commit(repo, head)):
        raise UnmergedBranchError(name)
    await delete_ref(dispatch, location.commondir, ref.decode())
    return (f"Deleted branch {name} "
            f"(was {short(sha, abbrev_for(repo))}).\n").encode()


async def branch(
        inv: CLIInvocation[None]) -> tuple[ByteSource | None, IOResult]:
    """List, create or delete branches.

    A name operand creates a branch, ``-d`` deletes one, and neither
    lists them with the checked-out one marked. ``-d`` deletes only a
    branch HEAD already contains, and ``-D`` deletes one regardless,
    which is git's own split and the reason both are here: without
    ``-D`` there is nothing ``-d`` can refuse to do. ``-r`` lists
    remote-tracking branches instead of local ones and ``-a`` lists
    both; local names sort together and remotes follow.

    Args:
        inv (CLIInvocation[None]): the line's invocation record.
            git declares no config_model, and the workspace doors
            it reads (dispatch, stat_path, mount_root) ride
            ``inv.ops``.
    """
    ops = inv.ops or CLIVerbOpts()
    dispatch = ops.dispatch
    stat_path = ops.stat_path
    mount_root = ops.mount_root
    texts = inv.texts
    flags = inv.flags
    fl = FlagView(flags)
    remotes_only = fl.as_bool("r")
    include_remotes = remotes_only or fl.as_bool("a")
    try:
        if dispatch is None:
            raise NoWorkspaceError()
        check_operands(texts, UnknownSwitchError)
        repo, location = await opened(fl, stat_path, mount_root, dispatch)
        head = await read_head(dispatch, location.gitdir)
        force = fl.as_bool("D")
        if fl.as_bool("delete") or force:
            if not texts:
                raise BranchNameRequiredError()
            deleted = b"".join([
                await _delete(dispatch, repo, location, head, name, force)
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
