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

from dataclasses import dataclass
from typing import Any, Callable

from dulwich.repo import BaseRepo

from mirage.commands.cli.builtin.git.changes import collect
from mirage.commands.cli.builtin.git.errors import GitError, NoWorkspaceError
from mirage.commands.cli.builtin.git.format import short
from mirage.commands.cli.builtin.git.objects import abbrev_for
from mirage.commands.cli.builtin.git.refs import read_head
from mirage.commands.cli.builtin.git.render import (branch_line, long_format,
                                                    short_format)
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.types import HeadRef, RepoLocation
from mirage.commands.cli.builtin.git.util import fatal
from mirage.commands.cli.builtin.git.worktree import (UNTRACKED_ALL,
                                                      UNTRACKED_NO,
                                                      UNTRACKED_NORMAL)
from mirage.commands.cli.types import CLIInvocation, CLIVerbOpts
from mirage.commands.spec.types import FlagView
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.ops.types import StatPath


@dataclass(frozen=True, slots=True)
class StatusFlags:
    """The parsed shape of a ``git status`` invocation.

    Args:
        porcelain (bool): ``--porcelain``, the stable machine format.
        short (bool): ``-s``, the same rows meant for a person.
        branch (bool): ``-b``, prepend the ``##`` branch line.
        untracked (str): ``-u``, which untracked files to report.
    """
    porcelain: bool
    short: bool
    branch: bool
    untracked: str


def parse_flags(fl: FlagView) -> StatusFlags:
    """Read the raw status flag kwargs into a frozen struct.

    ``-u`` carries its mode attached or not at all, and a bare one means
    ``all``, which is why the value is read as a string first and only
    then as a boolean.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
    """
    mode = fl.as_str("untracked_files")
    if mode is None:
        mode = UNTRACKED_ALL if fl.as_bool(
            "untracked_files") else UNTRACKED_NORMAL
    return StatusFlags(porcelain=fl.as_bool("porcelain"),
                       short=fl.as_bool("short"),
                       branch=fl.as_bool("branch"),
                       untracked=mode)


async def render_report(dispatch: Callable[..., Any], stat_path: StatPath,
                        repo: BaseRepo, location: RepoLocation,
                        head: HeadRef) -> str:
    """The default status report, as a string.

    Split out so ``commit`` can print it when it has nothing to commit:
    git shows the whole status there rather than a one-line refusal, and
    two renderings of the same thing would drift.

    Args:
        dispatch (Callable): workspace op dispatcher.
        stat_path (StatPath): dispatcher-backed stat, both channels.
        repo (BaseRepo): the opened repository.
        location (RepoLocation): the discovered repository.
        head (HeadRef): what HEAD points at.
    """
    rows, state, no_commits = await collect(dispatch, stat_path, repo,
                                            location, UNTRACKED_NORMAL)
    commit = None if head.commit is None else short(head.commit.encode(),
                                                    abbrev_for(repo))
    return long_format(rows, head.branch, commit, no_commits, state.merging,
                       False)


async def status(
        inv: CLIInvocation[None]) -> tuple[ByteSource | None, IOResult]:
    """Show the working tree status.

    Three sources, compared pairwise: HEAD's tree against the index says
    what a commit would record, and the index against the working tree
    says what it would leave behind. Everything the report prints is one
    of those two answers, or a path neither side knows about.

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
        parsed = parse_flags(fl)
        repo, location = await opened(fl, stat_path, mount_root, dispatch)
        head = await read_head(dispatch, location.gitdir)
        rows, state, no_commits = await collect(dispatch, stat_path, repo,
                                                location, parsed.untracked)
    except GitError as exc:
        return fatal(exc)
    commit = None if head.commit is None else short(head.commit.encode(),
                                                    abbrev_for(repo))
    if parsed.porcelain or parsed.short:
        header = branch_line(head.branch, commit,
                             no_commits) if parsed.branch else None
        body = short_format(rows, header)
    else:
        body = long_format(rows, head.branch, commit, no_commits,
                           state.merging, parsed.untracked == UNTRACKED_NO)
    return yield_bytes(body.encode()), IOResult()
