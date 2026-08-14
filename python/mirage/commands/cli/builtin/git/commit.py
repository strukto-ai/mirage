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
from mirage.commands.cli.builtin.git.util import fatal, links_of
from mirage.commands.cli.types import CLIDoors, CLIInvocation
from mirage.commands.spec.types import FlagView
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.ops.types import SessionView

# git tags the first commit on a branch so the reflog reads
# "commit (initial): ..." rather than plain "commit: ...".
ROOT_NOTE = " (initial)"
DEFAULT_NAME = "mirage"
DEFAULT_EMAIL = "mirage@localhost"
# The environment git reads an identity from. There is no
# config file behind a mount, so these are the only real source.
AUTHOR_NAME = "GIT_AUTHOR_NAME"
AUTHOR_EMAIL = "GIT_AUTHOR_EMAIL"
FALLBACK_EMAIL = "EMAIL"
UTC = 0


def identity(fl: FlagView, session: SessionView | None = None) -> bytes:
    """Who to record as author and committer.

    Three sources, in git's own order: ``--author`` outranks the
    environment, and the environment outranks the fallback. git reads
    ``GIT_AUTHOR_NAME`` and ``GIT_AUTHOR_EMAIL``, with ``EMAIL`` as the
    fallback address, all pinned against git 2.50.

    Two deliberate divergences, both because a config file is not
    reachable from a mount. ``user.name``/``user.email`` are never
    consulted, so the environment is the only place a real identity can
    come from; and where git refuses to commit with no identity at all,
    mirage records a stated default rather than a guess at the
    operator's name. The committer is the author here, where git tracks
    ``GIT_COMMITTER_*`` separately.

    Read through the session plane's door rather than the frozen
    ``inv.env`` snapshot, so a hidden name reads as unset exactly as it
    does in the shell.

    Args:
        fl (FlagView): the leaf's flag bag.
        session (SessionView | None): the session plane's door, None
            outside a workspace.
    """
    author = fl.as_str("author")
    if author:
        return author.encode()
    name = session.get(AUTHOR_NAME) if session is not None else None
    if name:
        email = (session.get(AUTHOR_EMAIL)
                 or session.get(FALLBACK_EMAIL)) if session else None
        return f"{name} <{email or DEFAULT_EMAIL}>".encode()
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
            git declares no config_model; the planes it reads
            (data through ``dispatch``, names through ``ns``) ride
            ``inv.doors``.
    """
    doors = inv.doors or CLIDoors()
    dispatch = doors.dispatch
    stat_path = doors.stat_path
    flags = inv.flags
    fl = FlagView(flags)
    try:
        if dispatch is None or stat_path is None:
            raise NoWorkspaceError()
        message = fl.as_str("message")
        if not message:
            raise MissingMessageError()
        repo, location = await opened(fl, doors)
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
                                                     location, head,
                                                     links_of(doors)))
        parents = [] if before is None else [repo.refs[HEAD_REF]]
        who = identity(fl, doors.session_view)
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
