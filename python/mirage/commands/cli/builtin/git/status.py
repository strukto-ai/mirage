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

from mirage.accessor.base import Accessor
from mirage.commands.cli.builtin.git.branch import branch_upstream
from mirage.commands.cli.builtin.git.changes import collect
from mirage.commands.cli.builtin.git.errors import GitError, NoWorkspaceError
from mirage.commands.cli.builtin.git.pathspec import repo_relative
from mirage.commands.cli.builtin.git.ref_list import detached_line
from mirage.commands.cli.builtin.git.refs import read_head
from mirage.commands.cli.builtin.git.render import (
    branch_line,
    long_format,
    relative_entries,
    short_format,
)
from mirage.commands.cli.builtin.git.repo import Repo, config_bool
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.types import (
    HeadRef,
    RepoLocation,
    StatusEntry,
)
from mirage.commands.cli.builtin.git.util import fatal, start_point
from mirage.commands.cli.builtin.git.worktree import (
    UNTRACKED_ALL,
    UNTRACKED_NO,
    UNTRACKED_NORMAL,
)
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.workspace.files import Files


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
    ignored: bool = False


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
        mode = (
            UNTRACKED_ALL
            if fl.as_bool("untracked_files")
            else UNTRACKED_NORMAL
        )
    version = fl.as_str("porcelain")
    if version is not None and version not in ("1", "v1"):
        raise GitError(f"unsupported porcelain version '{version}'")
    return StatusFlags(
        porcelain=fl.as_bool("porcelain") or version is not None,
        short=fl.as_bool("short"),
        branch=fl.as_bool("branch"),
        untracked=mode,
        ignored=fl.as_bool("ignored"),
    )


async def displayed(
    vfs: Files,
    location: RepoLocation,
    start: str,
    rows: list[StatusEntry],
) -> list[StatusEntry]:
    """Status rows as a person reads them, relative to where git runs.

    git's human formats name paths from the invocation directory unless
    ``status.relativePaths`` is false; porcelain never does. From outside
    the work tree they stay relative to its root.

    Args:
        vfs (Files): the session's files.
        location (RepoLocation): the discovered repository.
        start (str): absolute virtual path git is running in.
        rows (list[StatusEntry]): repository-relative status entries.
    """
    if not await config_bool(vfs, location, b"status", b"relativepaths", True):
        return rows
    return relative_entries(rows, repo_relative(location, start, "."))


async def render_report(
    vfs: Files,
    repo: Repo,
    location: RepoLocation,
    head: HeadRef,
    start: str,
) -> str:
    """The default status report, as a string.

    Split out so ``commit`` can print it when it has nothing to commit:
    git shows the whole status there rather than a one-line refusal, and
    two renderings of the same thing would drift.

    Args:
        vfs (Files): the session's files.
        repo (Repo): the opened repository.
        location (RepoLocation): the discovered repository.
        head (HeadRef): what HEAD points at.
        start (str): absolute virtual path git is running in, which the
            report's paths are relative to.
    """
    rows, state, no_commits = await collect(
        vfs, repo, location, UNTRACKED_NORMAL
    )
    fully = await config_bool(vfs, location, b"core", b"quotepath", True)
    detached = (
        "" if head.branch is not None else await detached_line(repo, head)
    )
    upstream = await branch_upstream(repo, head, no_commits)
    return long_format(
        await displayed(vfs, location, start, rows),
        head.branch,
        detached,
        no_commits,
        state.merging,
        False,
        fully,
        upstream,
    )


async def status(
    accessor: Accessor, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    """Show the working tree status.

    Three sources, compared pairwise: HEAD's tree against the index says
    what a commit would record, and the index against the working tree
    says what it would leave behind. Everything the report prints is one
    of those two answers, or a path neither side knows about.

    Args:
        accessor (Accessor): git reaches no service.
        paths (list[PathSpec]): the path operands; git declares none.
        texts (list[str]): the operands.
        ctx (Context): the line's context; git reads its repository
            through ``ctx.vfs``.
    """
    vfs = ctx.vfs
    flags = ctx.flags
    fl = FlagView(flags)
    try:
        if vfs is None:
            raise NoWorkspaceError()
        parsed = parse_flags(fl)
        repo, location = await opened(ctx, fl, work_tree=True)
        head = await read_head(vfs, location.gitdir)
        rows, state, no_commits = await collect(
            vfs,
            repo,
            location,
            parsed.untracked,
            parsed.ignored,
        )
        fully = await config_bool(vfs, location, b"core", b"quotepath", True)
        if not parsed.porcelain:
            rows = await displayed(
                vfs, location, start_point(fl).virtual, rows
            )
        upstream = await branch_upstream(repo, head, no_commits)
        detached = (
            "" if head.branch is not None else await detached_line(repo, head)
        )
    except GitError as exc:
        return fatal(exc)
    if parsed.porcelain or parsed.short:
        header = (
            branch_line(head.branch, no_commits, upstream)
            if parsed.branch
            else None
        )
        body = short_format(rows, header, fully)
    else:
        body = long_format(
            rows,
            head.branch,
            detached,
            no_commits,
            state.merging,
            parsed.untracked == UNTRACKED_NO,
            fully,
            upstream,
        )
    return yield_bytes(body.encode()), IOResult()
