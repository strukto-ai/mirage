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
from dataclasses import replace

from dulwich.objects import Commit
from dulwich.repo import BaseRepo

from mirage.commands.cli.builtin.git.constants import (
    HEAD,
    TEMPLATE_KINDS,
    TERMINATED_KINDS,
)
from mirage.commands.cli.builtin.git.diff_output import (
    DiffFlags,
    commit_entry,
    commit_output,
    parse_diff_flags,
    renames_enabled,
    separator_line,
)
from mirage.commands.cli.builtin.git.errors import GitError, NoWorkspaceError
from mirage.commands.cli.builtin.git.format import (
    FULL_SHA,
    Decorations,
    commit_header,
    preset_block,
    render_template,
)
from mirage.commands.cli.builtin.git.graph import CommitGraph
from mirage.commands.cli.builtin.git.history import (
    LogFlags,
    Walk,
    decorations,
    displayed,
    parse_flags,
    ref_commits,
    select,
    walked,
)
from mirage.commands.cli.builtin.git.objects import abbrev_for
from mirage.commands.cli.builtin.git.repo import config_bool
from mirage.commands.cli.builtin.git.revparse import split_revisions
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.types import Decoration
from mirage.commands.cli.builtin.git.util import check_operands, fatal
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.shell.bytes import encode_text
from mirage.types import PathSpec


def _collect(
    repo: BaseRepo,
    revisions: tuple[str, ...],
    flags: LogFlags,
) -> tuple[list[Commit], Walk | None, Decorations | None]:
    """Resolve the starting points and walk them, synchronously.

    Runs on a worker thread. dulwich's walker is synchronous and now
    fetches objects as it goes, so it has to sit off the event loop that
    serves those fetches; enumerating refs and peeling tags fetch the
    same way, which is why ``--all`` and the decoration table are
    resolved here too.

    Args:
        repo (BaseRepo): repository to walk.
        revisions (tuple[str, ...]): the revisions and ranges to walk,
            HEAD when none was given.
        flags (LogFlags): the parsed invocation, whose decoration style
            says whether to load ref labels and how to spell them.
    """
    starts, hidden = split_revisions(repo, revisions or (HEAD,))
    if flags.all_refs:
        starts.extend(ref_commits(repo))
    decor = decorations(repo, flags.decorate)
    if flags.graph:
        return [], walked(repo, starts, flags, tuple(hidden)), decor
    return select(repo, starts, flags, tuple(hidden)), None, decor


def _rendered(
    commits: list[Commit],
    flags: LogFlags,
    width: int,
    decor: Decorations | None,
) -> bytes:
    """The bytes a log invocation prints for its selected commits.

    ``format:`` separates entries with a newline and ends without one,
    and an entry that renders empty still claims its separator, so
    ``--pretty=format:`` prints one newline per commit past the first;
    a block preset separates its entries the same way. ``tformat:``
    (and any bare ``%`` string) and oneline terminate every entry
    instead. Pinned against git 2.37 and 2.54.

    Args:
        commits (list[Commit]): the selected commits, in print order.
        flags (LogFlags): the parsed invocation.
        width (int): abbreviated id width for this repository.
        decor (Decorations | None): ref labels when the format asked.
    """
    terminated = flags.pretty.kind in TERMINATED_KINDS
    return (b"" if terminated else b"\n").join(
        commit_header(commit, flags, width, decor) for commit in commits
    )


def _graphed(
    repo: BaseRepo,
    walk: Walk,
    flags: LogFlags,
    decor: Decorations | None,
    diff: DiffFlags | None,
) -> bytes:
    """The bytes a ``--graph`` log prints: git's show_log, commit by
    commit.

    Every walked commit moves the graph on, printed or not, so a commit
    the pickaxe passed by leaves a ``...`` row. A printed commit gets the
    graph's lines up to its own, then its header, then its text with the
    next graph line in front of each further line, then whatever lines
    the graph still owes. The formats that separate entries (medium and
    its kin, ``format:``) put the separator behind a padding line, so
    the graph never shows a gap; the ones that terminate entries
    (oneline, ``tformat:``) do the same after each entry. A padding line
    is skipped wherever the text before it ended without a newline,
    since it would then land on that text's own line.

    With a diff each block (one per parent under ``-m``) is an entry of
    its own, each naming its parent, and every diff line sits behind a
    padding line, the one between the message and the diff included.
    That line is ``---`` when both a diffstat and a patch follow, and is
    left out for oneline, except before a combined diff, which git
    prints from its own path. Synchronous, for a worker thread: the
    diffs read objects.

    Args:
        repo (BaseRepo): the opened repository.
        walk (Walk): the walked commits and the ones an edge may lead
            to.
        flags (LogFlags): the parsed invocation.
        decor (Decorations | None): ref labels per commit, when the
            format prints any.
        diff (DiffFlags | None): the diff flags, None when no diff was
            asked for.
    """
    width = abbrev_for(repo)
    graph = CommitGraph(walk.interesting.__contains__, flags.first_parent)
    mailmap = flags.mailmap if flags.use_mailmap else ()
    fmt = flags.pretty
    user = fmt.kind in TEMPLATE_KINDS
    terminated = fmt.kind in TERMINATED_KINDS
    empty = user and not fmt.template
    length = (
        FULL_SHA
        if fmt.kind == "oneline" and not flags.abbrev_commit
        else width
    )
    out = ""
    shown_one = False
    missing_newline = False
    for step in walk.steps:
        commit = step.commit
        graph.update(commit)
        if not step.shown:
            continue
        bodies = commit_output(repo, commit, diff) if diff is not None else []
        blocks = [
            (
                commit.parents[index].decode() if len(bodies) > 1 else None,
                body.decode("utf-8", "surrogateescape"),
            )
            for index, body in enumerate(bodies)
            if body is not None
        ]
        for parent, body in blocks or [(None, "")]:
            if shown_one and not terminated:
                if not missing_newline:
                    out += graph.padding_line()
                out += "\n"
            shown_one = True
            out += graph.show_commit()
            source = ""
            if not user and parent is not None:
                cut = length if fmt.kind == "oneline" else FULL_SHA
                source = f" (from {parent[:cut]})"
            labels = (
                render_template("%d", commit, width, decor)
                if flags.decorate is not Decoration.NONE
                else ""
            )
            if fmt.kind == "oneline":
                out += (
                    f"{render_template('%h', commit, length, decor)}"
                    f"{source}{labels} "
                )
                text = render_template("%s", commit, length, decor)
            elif user:
                text = render_template(
                    fmt.template or "",
                    commit,
                    width,
                    decor,
                    flags.date,
                    flags.mailmap,
                )
            else:
                head, *rest = preset_block(
                    commit, fmt.kind, width, flags.date, mailmap
                )
                out += f"{head}{source}{labels}\n{graph.next_line()[0]}"
                text = "".join(f"{line}\n" for line in rest)
            missing_newline = not text.endswith("\n")
            out += graph.show_message(text)
            if terminated and not empty:
                if not missing_newline:
                    out += graph.padding_line()
                out += "\n"
            if body == "" or diff is None:
                continue
            separator = (
                None if empty else separator_line(commit, fmt.kind, diff)
            )
            if separator is not None:
                out += f"{graph.padding_line()}{separator}\n"
            for line in body.split("\n")[:-1]:
                out += f"{graph.padding_line()}{line}\n"
    return encode_text(out)


async def log(
    config: None, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    """Show commit logs.

    Args:
        config (None): git declares no config_model.
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
        check_operands(ctx, texts)
        parsed = parse_flags(fl, ctx.env)
        repo, location = await opened(ctx, fl)
        mailmap, mapped, decorate = await displayed(
            vfs, location, fl, parsed.pretty
        )
        parsed = replace(
            parsed, mailmap=mailmap, use_mailmap=mapped, decorate=decorate
        )
        commits, walk, decor = await asyncio.to_thread(
            _collect, repo, tuple(texts), parsed
        )
        diff_flags = parse_diff_flags(fl, default_patch=False)
    except GitError as exc:
        return fatal(exc)
    diffing = any(
        (
            diff_flags.patch,
            diff_flags.stat,
            diff_flags.name_only,
            diff_flags.name_status,
            diff_flags.numstat,
            diff_flags.shortstat,
            diff_flags.summary,
            diff_flags.raw,
        )
    )
    if diffing:
        diff_flags = parse_diff_flags(
            fl,
            default_patch=False,
            default_renames=await renames_enabled(vfs, location),
            quote_path_fully=await config_bool(
                vfs, location, b"core", b"quotepath", True
            ),
        )
    if walk is not None:
        out = await asyncio.to_thread(
            _graphed,
            repo,
            walk,
            parsed,
            decor,
            diff_flags if diffing else None,
        )
    elif diffing:
        blocks = [
            await asyncio.to_thread(
                commit_entry, repo, commit, parsed, diff_flags, decor
            )
            for commit in commits
        ]
        out = (b"" if parsed.pretty.kind in TERMINATED_KINDS else b"\n").join(
            blocks
        )
    else:
        out = _rendered(commits, parsed, abbrev_for(repo), decor)
    if not out:
        return None, IOResult()
    return yield_bytes(out), IOResult()
