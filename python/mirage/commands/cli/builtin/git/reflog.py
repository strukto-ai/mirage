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
from typing import Any, Callable

from mirage.commands.cli.builtin.git.io import read_optional, write_file

LOGS_DIR = "logs"
HEAD_LOG = "logs/HEAD"
ZERO = b"0" * 40


def entry(before: bytes, after: bytes, who: bytes, when: int,
          message: str) -> bytes:
    """One reflog line, in git's own format.

    ``<old> <new> <identity> <epoch> <offset>\\t<message>``, with the
    old id all zeroes when there was nothing there before. The tab is
    load-bearing: it is what separates the fixed fields from a message
    that may itself contain spaces.

    Args:
        before (bytes): the id the ref held, zeroes when it held none.
        after (bytes): the id it now holds.
        who (bytes): the identity, ``Name <email>``.
        when (int): epoch seconds.
        message (str): what happened, e.g. ``commit: add delta``.
    """
    return (b"%s %s %s %d +0000\t%s\n" %
            (before, after, who, when, message.encode()))


async def append(dispatch: Callable[..., Any], gitdir: str, path: str,
                 line: bytes) -> None:
    """Add one line to a reflog, creating it if it is not there.

    Read-modify-write rather than an append op, because not every
    backend offers one and a reflog is small. Losing the history here
    would only cost the ``@{n}`` syntax, but ``git branch`` reads it to
    say where a detached HEAD detached from, so an absent log makes a
    perfectly good checkout read as ``(no branch)``.

    Args:
        dispatch (Callable): workspace op dispatcher.
        gitdir (str): absolute virtual path of the git directory owning
            the log.
        path (str): log path relative to it, e.g. ``logs/HEAD``.
        line (bytes): the line to add, newline included.
    """
    target = posixpath.join(gitdir, path)
    existing = await read_optional(dispatch, target)
    await write_file(dispatch, target, (existing or b"") + line)


async def record(dispatch: Callable[..., Any], gitdir: str, ref: str | None,
                 before: bytes | None, after: bytes, who: bytes, when: int,
                 message: str) -> None:
    """Record one move of HEAD, and of the branch it is on.

    git writes both logs on every update: ``logs/HEAD`` always, and the
    branch's own log when HEAD is attached to one. Both carry the same
    line.

    Args:
        dispatch (Callable): workspace op dispatcher.
        gitdir (str): absolute virtual path of this checkout's git
            directory, which owns the logs.
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
        await append(dispatch, gitdir, posixpath.join(LOGS_DIR, ref), line)
