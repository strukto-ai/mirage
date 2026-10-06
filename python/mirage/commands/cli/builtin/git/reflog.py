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
import posixpath

from mirage.commands.cli.builtin.git.constants import HEAD
from mirage.commands.cli.builtin.git.discover import is_bare
from mirage.commands.cli.builtin.git.errors import GitError
from mirage.commands.cli.builtin.git.io import read_optional, write_file
from mirage.commands.cli.builtin.git.objects import abbrev_for
from mirage.commands.cli.builtin.git.repo import config_values
from mirage.commands.cli.builtin.git.revparse import resolve_commit
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.types import RepoLocation
from mirage.commands.cli.builtin.git.util import (
    check_operands,
    fatal,
    maybe_bool,
)
from mirage.commands.cli.types import CLIDoors, CLIInvocation
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.runtime.types import DispatchFn

LOGS_DIR = "logs"
HEAD_LOG = "logs/HEAD"
ZERO = b"0" * 40
# What a move of HEAD or a new branch records in the reflog. There is no
# committer there, only a ref moving, so the stated identity commit uses
# is reused.
IDENTITY = b"mirage <mirage@localhost>"
LOGGED_PREFIXES = ("refs/heads/", "refs/remotes/", "refs/notes/")


def entry(
    before: bytes, after: bytes, who: bytes, when: int, message: str
) -> bytes:
    """One reflog line, in git's own format.

    ``<old> <new> <identity> <epoch> <offset>\\t<message>``, with the
    old id all zeroes when there was nothing there before. The tab is
    load-bearing: it is what separates the fixed fields from a message
    that may itself contain spaces. An empty message leaves the tab
    out, as git does.

    Args:
        before (bytes): the id the ref held, zeroes when it held none.
        after (bytes): the id it now holds.
        who (bytes): the identity, ``Name <email>``.
        when (int): epoch seconds.
        message (str): what happened, e.g. ``commit: add delta``.
    """
    tail = b"\t" + message.encode() if message else b""
    return b"%s %s %s %d +0000%s\n" % (before, after, who, when, tail)


async def append(
    dispatch: DispatchFn, gitdir: str, path: str, line: bytes
) -> None:
    """Add one line to a reflog, creating it if it is not there.

    Read-modify-write rather than an append op, because not every
    backend offers one and a reflog is small. Losing the history here
    would only cost the ``@{n}`` syntax, but ``git branch`` reads it to
    say where a detached HEAD detached from, so an absent log makes a
    perfectly good checkout read as ``(no branch)``.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        gitdir (str): absolute virtual path of the git directory owning
            the log.
        path (str): log path relative to it, e.g. ``logs/HEAD``.
        line (bytes): the line to add, newline included.
    """
    target = posixpath.join(gitdir, path)
    existing = await read_optional(dispatch, target)
    await write_file(dispatch, target, (existing or b"") + line)


async def logged(
    dispatch: DispatchFn, location: RepoLocation, name: str, log: str
) -> bool:
    """Whether an update to a ref is logged.

    Always where its log already exists, and otherwise as
    ``core.logAllRefUpdates`` says, which defaults to HEAD and the
    branch, remote and notes refs outside a bare repository, and to
    nothing in one (``should_autocreate_reflog``).

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        location (RepoLocation): the discovered repository.
        name (str): the full ref name.
        log (str): the path of its log.
    """
    if await read_optional(dispatch, log) is not None:
        return True
    values = await config_values(
        dispatch, location, b"core", b"logallrefupdates"
    )
    if values and values[-1].lower() == b"always":
        return True
    if values:
        normal = bool(maybe_bool(values[-1]))
    else:
        normal = not await is_bare(dispatch, location)
    return normal and (name == HEAD or name.startswith(LOGGED_PREFIXES))


async def record(
    dispatch: DispatchFn,
    gitdir: str,
    commondir: str,
    ref: str | None,
    before: bytes | None,
    after: bytes,
    who: bytes,
    when: int,
    message: str,
) -> None:
    """Record one move of HEAD, and of the branch it is on.

    git writes both logs on every update: ``logs/HEAD`` always, and the
    branch's own log when HEAD is attached to one. Both carry the same
    line. HEAD's log belongs to the checkout and a branch's to the
    repository, so a linked worktree splits them the way git does.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        gitdir (str): absolute virtual path of this checkout's git
            directory, which owns HEAD's log.
        commondir (str): absolute virtual path of the shared git
            directory, which owns the branches' logs.
        ref (str | None): the branch ref that also moved, None when
            HEAD is detached.
        before (bytes | None): the id HEAD held, None when it held none.
        after (bytes): the id it now holds.
        who (bytes): the identity to record.
        when (int): epoch seconds.
        message (str): what happened.
    """
    line = entry(before or ZERO, after, who, when, message)
    await append(dispatch, gitdir, HEAD_LOG, line)
    if ref is not None:
        await append(dispatch, commondir, posixpath.join(LOGS_DIR, ref), line)


async def _log_of(
    dispatch: DispatchFn, location: RepoLocation, ref: str
) -> bytes | None:
    """A ref's reflog, from the git directory that owns it.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        location (RepoLocation): the discovered repository.
        ref (str): the ref name, ``HEAD`` or a full ``refs/`` name.
    """
    root = location.gitdir if ref == HEAD else location.commondir
    return await read_optional(dispatch, posixpath.join(root, LOGS_DIR, ref))


async def _named_log(
    dispatch: DispatchFn, location: RepoLocation, revision: str
) -> tuple[str, bytes | None]:
    """The log a reflog walk reads, and the name its rows print.

    As git's ``read_complete_reflog`` then ``dwim_log``: the name as
    typed, then under ``refs/`` and ``refs/heads/``, keep the spelling;
    only a log found by the full rev-parse rules (a tag, a remote) is
    printed by its full name (git 2.47.3 and 2.50.1).

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        location (RepoLocation): the discovered repository.
        revision (str): the ref as typed.
    """
    for ref in (revision, f"refs/{revision}", f"refs/heads/{revision}"):
        data = await _log_of(dispatch, location, ref)
        if data:
            return revision, data
    for ref in (
        f"refs/tags/{revision}",
        f"refs/remotes/{revision}",
        f"refs/remotes/{revision}/HEAD",
    ):
        data = await _log_of(dispatch, location, ref)
        if data:
            return ref, data
    return revision, None


async def reflog(
    inv: CLIInvocation[None],
) -> tuple[ByteSource | None, IOResult]:
    """Read a ref's log newest first through the dispatcher.

    Args:
        inv (CLIInvocation[None]): optional show verb, ref and entry limit.
    """
    fl = FlagView(inv.flags)
    try:
        texts = inv.texts[1:] if inv.texts[:1] == ("show",) else inv.texts
        check_operands(inv, texts)
        doors = inv.doors or CLIDoors()
        repo, location = await opened(fl, doors)
        assert doors.dispatch is not None
        revision = texts[0] if texts else HEAD
        await asyncio.to_thread(resolve_commit, repo, revision)
        name, data = await _named_log(doors.dispatch, location, revision)
        rows = list(reversed((data or b"").splitlines()))
        limit = fl.as_int("max_count")
        if limit is not None and limit >= 0:
            rows = rows[:limit]
        width = abbrev_for(repo)
        out = []
        for index, row in enumerate(rows):
            record, _, message = row.partition(b"\t")
            oid = record.split(b" ")[1]
            out.append(
                f"{oid.decode()[:width]} {name}@{{{index}}}: "
                f"{message.decode('utf-8', 'replace')}\n"
            )
        return "".join(out).encode(), IOResult()
    except GitError as exc:
        return fatal(exc)
