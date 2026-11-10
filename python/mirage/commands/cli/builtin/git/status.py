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
from dataclasses import dataclass

from mirage.accessor.base import Accessor
from mirage.commands.cli.builtin.git.branch import branch_upstream
from mirage.commands.cli.builtin.git.changes import (
    RENAME_THRESHOLD,
    StatusRow,
    assembled,
    collect,
)
from mirage.commands.cli.builtin.git.diff_output import similarity
from mirage.commands.cli.builtin.git.errors import GitError
from mirage.commands.cli.builtin.git.io import read_optional
from mirage.commands.cli.builtin.git.pathspec import (
    pathspec_patterns,
    pathspec_selects,
    repo_relative,
)
from mirage.commands.cli.builtin.git.ref_list import detached_line
from mirage.commands.cli.builtin.git.refs import read_head
from mirage.commands.cli.builtin.git.render import (
    branch_line,
    long_format,
    relative_entries,
    short_format,
)
from mirage.commands.cli.builtin.git.repo import (
    Repo,
    config_bool,
    config_values,
)
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.types import HeadRef, RepoLocation
from mirage.commands.cli.builtin.git.util import (
    check_switches,
    maybe_bool,
    require_vfs,
    start_point,
)
from mirage.commands.cli.builtin.git.worktree import (
    UNTRACKED_ALL,
    UNTRACKED_NO,
    UNTRACKED_NORMAL,
)
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult, Rows
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
        ignored (bool): ``--ignored``, report ignored files too.
        nul (bool): ``-z``, end entries with NUL.
    """

    porcelain: bool
    short: bool
    branch: bool
    untracked: str
    ignored: bool = False
    nul: bool = False


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
    nul = fl.as_bool("null")
    formats = fl.typed_order("short", "long", "porcelain")
    last = formats[-1] if formats else ""
    if nul and fl.as_bool("long"):
        raise GitError("options '--long' and '-z' cannot be used together")
    return StatusFlags(
        porcelain=last == "porcelain" or (nul and last != "short"),
        short=last == "short",
        branch=fl.as_bool("branch"),
        untracked=mode,
        ignored=fl.as_bool("ignored"),
        nul=nul,
    )


async def _chosen(
    vfs: Files,
    location: RepoLocation,
    fl: FlagView,
    on: str,
    off: str,
    variable: bytes,
    default: bool,
) -> bool:
    """A setting the line can turn on or off and config otherwise decides.

    Args:
        vfs (Files): the session's files.
        location (RepoLocation): the discovered repository.
        fl (FlagView): parsed flags.
        on (str): the flag turning it on.
        off (str): the flag turning it off.
        variable (bytes): the name in the ``status`` section.
        default (bool): the answer with neither flag nor config.
    """
    typed = fl.typed_order(on, off)
    if typed:
        return typed[-1] == on
    return await config_bool(vfs, location, b"status", variable, default)


async def _rename_threshold(
    vfs: Files, location: RepoLocation, fl: FlagView
) -> int | None:
    """The similarity a status rename needs, None for no pairing.

    Args:
        vfs (Files): the session's files.
        location (RepoLocation): the discovered repository.
        fl (FlagView): parsed flags.
    """
    typed = fl.typed_order("renames", "no_renames", "find_renames")
    if typed and typed[-1] == "no_renames":
        return None
    if typed and typed[-1] == "find_renames":
        value = fl.raw("find_renames")
        return similarity(value) if isinstance(value, str) and value else 50
    if typed:
        return RENAME_THRESHOLD
    values = await config_values(vfs, location, b"status", b"renames")
    if values and maybe_bool(values[-1]) is False:
        return None
    return RENAME_THRESHOLD


async def _stash_count(vfs: Files, location: RepoLocation) -> int:
    """How many stashes the repository holds.

    Args:
        vfs (Files): the session's files.
        location (RepoLocation): the discovered repository.
    """
    data = await read_optional(vfs, location.commondir.join("logs/refs/stash"))
    return len([row for row in (data or b"").splitlines() if row])


async def relative_prefix(
    vfs: Files, location: RepoLocation, start: str
) -> str:
    """Where a person's status report names paths from, relative to the
    work tree.

    git's human formats name paths from the invocation directory unless
    ``status.relativePaths`` is false; porcelain never does. From outside
    the work tree they stay relative to its root.

    Args:
        vfs (Files): the session's files.
        location (RepoLocation): the discovered repository.
        start (str): absolute virtual path git is running in.

    Returns:
        str: the invocation directory relative to the work tree, empty
            for paths named from its root.
    """
    if not await config_bool(vfs, location, b"status", b"relativepaths", True):
        return ""
    return repo_relative(location, start, ".")


async def report_rows(
    vfs: Files,
    repo: Repo,
    location: RepoLocation,
    head: HeadRef,
    start: str,
) -> Rows[StatusRow]:
    """The default status report, as rows and their renderer.

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
    prefix = await relative_prefix(vfs, location, start)

    async def render(shown: list[StatusRow]) -> ByteSource:
        entries = await asyncio.to_thread(assembled, repo.object_store, shown)
        body = long_format(
            relative_entries(entries, prefix),
            head.branch,
            detached,
            no_commits,
            state.merging,
            False,
            fully,
            upstream,
        )
        return body.encode()

    return Rows(rows, render)


async def status(
    accessor: Accessor, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    """Show the working tree status.

    Three sources, compared pairwise: HEAD's tree against the index says
    what a commit would record, and the index against the working tree
    says what it would leave behind. Everything the report prints is one
    of those two answers, or a path neither side knows about. Each path
    is handed over as a row, so the report names and counts only the
    paths the session sees.

    Args:
        accessor (Accessor): git reaches no service.
        paths (list[PathSpec]): the path operands; git declares none.
        texts (list[str]): the operands.
        ctx (Context): the line's context; git reads its repository
            through ``ctx.vfs``.
    """
    vfs = require_vfs(ctx)
    flags = ctx.flags
    fl = FlagView(flags)
    parsed = parse_flags(fl)
    check_switches(ctx, texts)
    repo, location = await opened(ctx, fl, work_tree=True)
    head = await read_head(vfs, location.gitdir)
    start = start_point(fl).virtual
    patterns = pathspec_patterns(location, start, texts)
    show_stash = await _chosen(
        vfs, location, fl, "show_stash", "no_show_stash", b"showstash", False
    )
    ahead_behind = await _chosen(
        vfs,
        location,
        fl,
        "ahead_behind",
        "no_ahead_behind",
        b"aheadbehind",
        True,
    )
    threshold = await _rename_threshold(vfs, location, fl)
    rows, state, no_commits = await collect(
        vfs,
        repo,
        location,
        parsed.untracked,
        parsed.ignored,
    )
    if patterns:
        rows = [
            row
            for row in rows
            if pathspec_selects(row.name.rstrip("/"), patterns)
        ]
    fully = await config_bool(vfs, location, b"core", b"quotepath", True)
    prefix = (
        "" if parsed.porcelain else await relative_prefix(vfs, location, start)
    )
    stashes = await _stash_count(vfs, location) if show_stash else 0
    upstream = await branch_upstream(repo, head, no_commits)
    detached = (
        "" if head.branch is not None else await detached_line(repo, head)
    )

    async def render(shown: list[StatusRow]) -> ByteSource:
        entries = relative_entries(
            await asyncio.to_thread(
                assembled, repo.object_store, shown, threshold
            ),
            prefix,
        )
        if parsed.porcelain or parsed.short:
            header = (
                branch_line(head.branch, no_commits, upstream, ahead_behind)
                if parsed.branch
                else None
            )
            body = short_format(entries, header, fully, parsed.nul)
        else:
            body = long_format(
                entries,
                head.branch,
                detached,
                no_commits,
                state.merging,
                parsed.untracked == UNTRACKED_NO,
                fully,
                upstream,
                ahead_behind,
            )
            if stashes:
                noun = "entry" if stashes == 1 else "entries"
                body += f"Your stash currently has {stashes} {noun}\n"
        return body.encode()

    return None, IOResult(rows=Rows(rows, render))
