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
import time

from dulwich.index import commit_tree
from dulwich.objects import Commit, ObjectID
from dulwich.repo import BaseRepo

from mirage.commands.cli.builtin.git.changes import head_entries
from mirage.commands.cli.builtin.git.errors import (GitError,
                                                    MissingMessageError,
                                                    NothingToCommitError,
                                                    NoWorkspaceError,
                                                    UnmergedIndexError)
from mirage.commands.cli.builtin.git.index import read_index
from mirage.commands.cli.builtin.git.objects import abbrev_for
from mirage.commands.cli.builtin.git.reflog import record
from mirage.commands.cli.builtin.git.refs import (HEAD_REF, detach_head,
                                                  read_head, write_ref)
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.status import render_report
from mirage.commands.cli.builtin.git.summary import report
from mirage.commands.cli.builtin.git.types import IndexState
from mirage.commands.cli.builtin.git.util import fatal
from mirage.commands.cli.types import CLIInvocation, CLIVerbOpts
from mirage.commands.spec.types import FlagView
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult

# git tags the first commit on a branch so the reflog reads
# "commit (initial): ..." rather than plain "commit: ...".
ROOT_NOTE = " (initial)"
DEFAULT_NAME = "mirage"
DEFAULT_EMAIL = "mirage@localhost"
UTC = 0


def identity(fl: FlagView) -> bytes:
    """Who to record as author and committer.

    git reads ``user.name`` and ``user.email`` from a config file it
    finds by walking the filesystem and the user's home directory.
    Neither is reachable from a mount, so the identity is taken from
    ``--author`` when given and is otherwise a stated default rather
    than a guess at the operator's own name.

    Args:
        fl (FlagView): the leaf's flag bag.
    """
    author = fl.as_str("author")
    if author:
        return author.encode()
    return f"{DEFAULT_NAME} <{DEFAULT_EMAIL}>".encode()


def build_commit(repo: BaseRepo, state: IndexState, message: str,
                 author: bytes, parents: list[ObjectID],
                 when: int) -> tuple[Commit, dict[bytes, tuple[int, bytes]]]:
    """Write the trees the index describes and the commit above them.

    Synchronous, and called on a worker thread: every tree written goes
    back through the dispatcher.

    Args:
        repo (BaseRepo): the opened repository.
        state (IndexState): the index to commit.
        message (str): the commit message.
        author (bytes): the identity to record on both sides.
        parents (list[bytes]): parent commit ids, empty for a root
            commit.
        when (int): the commit timestamp, in epoch seconds.
    """
    store = repo.object_store
    blobs = [(path, entry.sha, entry.mode)
             for path, entry in sorted(state.entries.items())]
    tree = commit_tree(store, blobs)
    commit = Commit()
    commit.tree = tree
    commit.parents = parents
    commit.author = author
    commit.committer = author
    commit.author_time = when
    commit.commit_time = when
    commit.author_timezone = UTC
    commit.commit_timezone = UTC
    commit.encoding = b"UTF-8"
    commit.message = message.encode() + b"\n"
    store.add_object(commit)
    return commit, {
        path: (entry.mode, entry.sha)
        for path, entry in state.entries.items()
    }


async def commit(
        inv: CLIInvocation[None]) -> tuple[ByteSource | None, IOResult]:
    """Record the index as a new commit on the current branch.

    The message must come from ``-m``: git would otherwise open an
    editor, which a mount has no way to offer, and inventing a message
    would put an unreviewed one into history.

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
    flags = inv.flags
    fl = FlagView(flags)
    try:
        if stat_path is None or mount_root is None or dispatch is None:
            raise NoWorkspaceError()
        message = fl.as_str("message")
        if not message:
            raise MissingMessageError()
        repo, location = await opened(fl, stat_path, mount_root, dispatch)
        state = await read_index(dispatch, location.gitdir)
        if state.conflicts:
            raise UnmergedIndexError()
        head = await read_head(dispatch, location.gitdir)
        before = await asyncio.to_thread(head_entries, repo)
        after = {
            path: (entry.mode, entry.sha)
            for path, entry in state.entries.items()
        }
        if before is not None and before == after:
            raise NothingToCommitError(await
                                       render_report(dispatch, stat_path, repo,
                                                     location, head))
        parents = [] if before is None else [repo.refs[HEAD_REF]]
        who = identity(fl)
        when = int(time.time())
        written, tree = await asyncio.to_thread(build_commit, repo, state,
                                                message, who, parents, when)
        if head.ref is not None:
            await write_ref(dispatch, location.commondir, head.ref, written.id)
        else:
            await detach_head(dispatch, location.gitdir, written.id)
        await record(
            dispatch, location.gitdir, head.ref,
            parents[0] if parents else None, written.id, who, when,
            f"commit{ROOT_NOTE if before is None else ''}: "
            f"{message.splitlines()[0]}")
    except GitError as exc:
        return fatal(exc)
    body = report(repo.object_store, written, head.branch, before or {}, tree,
                  abbrev_for(repo), before is None)
    return yield_bytes(body), IOResult()
