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
from collections.abc import Mapping
from dataclasses import replace

from dulwich.objects import Commit
from dulwich.repo import BaseRepo

from mirage.accessor.base import Accessor
from mirage.commands.cli.builtin.git.constants import (
    HEAD,
    TEMPLATE_KINDS,
    TERMINATED_KINDS,
)
from mirage.commands.cli.builtin.git.diff_output import (
    COMBINED_MODE,
    DiffFlags,
    commit_deltas,
    commit_entry,
    commit_output,
    commit_shown,
    is_combined,
    parse_diff_flags,
    renames_enabled,
    separator_line,
)
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
    WalkStep,
    decorations,
    displayed,
    in_print_order,
    parse_flags,
    ref_commits,
    walk_ends,
    walk_operands,
    walked,
)
from mirage.commands.cli.builtin.git.objects import abbrev_for
from mirage.commands.cli.builtin.git.repo import config_bool
from mirage.commands.cli.builtin.git.rows import Delta, Side
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.types import Decoration
from mirage.commands.cli.builtin.git.util import (
    check_operands,
    require_vfs,
)
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult, Rows
from mirage.shell.bytes import encode_text
from mirage.types import PathSpec

# How ``--boundary`` marks a commit outside ``--graph``, and the word a
# block preset's header starts with.
BOUNDARY_PREFIX = b"- "
COMMIT_WORD = b"commit "


def _collect(
    repo: BaseRepo,
    revisions: tuple[str, ...],
    flags: LogFlags,
    diff: DiffFlags,
    dashed: bool = False,
) -> tuple[list[Commit], Walk, Decorations | None]:
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
        diff (DiffFlags): the diff the pickaxe searches.
        dashed (bool): whether ``--`` is on the line, which makes an
            operand that resolves to nothing a bad revision.
    """
    starts, hidden = walk_ends(repo, revisions or (HEAD,), dashed)
    if flags.all_refs:
        starts.extend(ref_commits(repo))
    decor = decorations(repo, flags.decorate)
    walk = walked(repo, starts, flags, tuple(hidden), diff)
    return in_print_order(walk, flags), walk, decor


def _marked(entry: bytes, kind: str) -> bytes:
    """A ``--boundary`` commit's entry outside ``--graph``: a oneline row
    starts ``- ``, and a block preset's header reads ``commit - <id>``;
    a user format and email print it as they print any commit (git
    2.47.3).

    Args:
        entry (bytes): the entry as any commit's would read.
        kind (str): the pretty format's kind.
    """
    if kind == "oneline":
        return BOUNDARY_PREFIX + entry
    if kind in TEMPLATE_KINDS or not entry.startswith(COMMIT_WORD):
        return entry
    return COMMIT_WORD + BOUNDARY_PREFIX + entry[len(COMMIT_WORD) :]


def _rendered(
    commits: list[Commit],
    flags: LogFlags,
    width: int,
    decor: Decorations | None,
    boundary: frozenset[bytes] = frozenset(),
    parents: Mapping[bytes, tuple[bytes, ...]] | None = None,
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
        boundary (frozenset[bytes]): the ``--boundary`` commits.
        parents (Mapping[bytes, tuple[bytes, ...]] | None): the parents a
            path-limited walk prints its commits with.
    """
    terminated = flags.pretty.kind in TERMINATED_KINDS
    drawn = parents or {}
    entries = (
        (
            commit,
            commit_header(commit, flags, width, decor, drawn.get(commit.id)),
        )
        for commit in commits
    )
    return (b"" if terminated else b"\n").join(
        _marked(entry, flags.pretty.kind) if commit.id in boundary else entry
        for commit, entry in entries
    )


def _graphed(
    repo: BaseRepo,
    walk: Walk,
    flags: LogFlags,
    decor: Decorations | None,
    diff: DiffFlags | None,
    sides: dict[bytes, list[Side]],
) -> bytes:
    """The bytes a ``--graph`` log prints, commit by commit.

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
    prints from its own path: a merge's combined diff gets the line
    even when nothing follows it, as does an empty ``--summary`` outside
    oneline, and the combined diff's ``mode`` lines and its
    ``--name-only`` or ``--name-status`` rows go out with no graph in
    front of them at all (git 2.47.3). Synchronous, for a worker thread:
    the diffs read objects.

    Args:
        repo (BaseRepo): the opened repository.
        walk (Walk): the walked commits and the ones an edge may lead
            to.
        flags (LogFlags): the parsed invocation.
        decor (Decorations | None): ref labels per commit, when the
            format prints any.
        diff (DiffFlags | None): the diff flags, None when no diff was
            asked for.
        sides (dict[bytes, list[Side]]): each shown commit's
            comparisons, as the session sees them, when a diff was
            asked for.
    """
    width = abbrev_for(repo)
    graph = CommitGraph(
        walk.interesting.__contains__,
        flags.first_parent,
        frozenset(commit.id for commit in walk.boundary),
        walk.parents or None,
    )
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
    for step in (*walk.steps, *(WalkStep(c, True) for c in walk.boundary)):
        commit = step.commit
        graph.walk(commit)
        if not step.shown:
            continue
        bodies = (
            commit_output(repo, commit, diff, sides[commit.id])
            if diff is not None
            else []
        )
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
                    out += graph.filler()
                out += "\n"
            shown_one = True
            out += graph.lead_in()
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
                    walk.parents.get(commit.id),
                )
            else:
                head, *rest = preset_block(
                    commit,
                    fmt.kind,
                    width,
                    flags.date,
                    mailmap,
                    walk.parents.get(commit.id),
                )
                out += f"{head}{source}{labels}\n{graph.next_row()}"
                text = "".join(f"{line}\n" for line in rest)
            missing_newline = not text.endswith("\n")
            out += graph.around(text)
            if terminated and not empty:
                if not missing_newline:
                    out += graph.filler()
                out += "\n"
            combined = diff is not None and is_combined(commit, diff)
            if diff is None or not blocks:
                continue
            if body == "" and not (
                combined or (diff.summary and fmt.kind != "oneline")
            ):
                continue
            separator = (
                None if empty else separator_line(commit, fmt.kind, diff)
            )
            if separator is not None:
                out += f"{graph.filler()}{separator}\n"
            names = combined and (diff.name_only or diff.name_status)
            for line in body.split("\n")[:-1]:
                if names or (combined and line.startswith(COMBINED_MODE)):
                    out += f"{line}\n"
                else:
                    out += f"{graph.filler()}{line}\n"
    return encode_text(out)


async def log(
    accessor: Accessor, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    """Show commit logs.

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
    check_operands(ctx, texts)
    parsed = parse_flags(fl, ctx.env)
    repo, location = await opened(ctx, fl)
    revisions, patterns, dashed = await walk_operands(
        ctx, fl, repo, location, texts
    )
    parsed = replace(parsed, pathspecs=patterns)
    mailmap, mapped, decorate = await displayed(
        vfs, location, fl, parsed.pretty
    )
    parsed = replace(
        parsed, mailmap=mailmap, use_mailmap=mapped, decorate=decorate
    )
    diff_flags = parse_diff_flags(fl, default_patch=False)
    # The pickaxe searches the diff, renames paired, whether or not
    # any of it is printed, which is how ``-S -m`` comes to name the
    # parent each printed entry matched against.
    diffing = parsed.pickaxe is not None or any(
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
    diff_flags = replace(
        diff_flags, pickaxe=parsed.pickaxe, pathspecs=patterns
    )
    commits, walk, decor = await asyncio.to_thread(
        _collect, repo, revisions, parsed, diff_flags, dashed
    )
    boundary = frozenset(commit.id for commit in walk.boundary)
    if not diffing:
        out = (
            await asyncio.to_thread(
                _graphed, repo, walk, parsed, decor, None, {}
            )
            if parsed.graph
            else _rendered(
                commits,
                parsed,
                abbrev_for(repo),
                decor,
                boundary,
                walk.parents,
            )
        )
        return out or None, IOResult()
    shown_commits = (
        [*(step.commit for step in walk.steps if step.shown), *walk.boundary]
        if parsed.graph
        else commits
    )
    rows, spans = await asyncio.to_thread(
        commit_deltas, repo, location, shown_commits, diff_flags
    )
    # A commit whose summary is empty still gets the blank line under its
    # header, as ``show`` gives one, though not under oneline (git
    # 2.47.3).
    summary = (
        diff_flags.summary
        and not diff_flags.no_patch
        and parsed.pretty.kind != "oneline"
    )

    async def render(shown: list[Delta]) -> ByteSource | None:
        sides = commit_shown(shown, spans)
        if parsed.graph:
            out = await asyncio.to_thread(
                _graphed, repo, walk, parsed, decor, diff_flags, sides
            )
        else:
            blocks = []
            for commit in commits:
                entry = await asyncio.to_thread(
                    commit_entry,
                    repo,
                    commit,
                    parsed,
                    diff_flags,
                    sides[commit.id],
                    decor,
                    summary,
                    walk.parents.get(commit.id),
                )
                if commit.id in boundary:
                    entry = _marked(entry, parsed.pretty.kind)
                blocks.append(entry)
            out = (
                b"" if parsed.pretty.kind in TERMINATED_KINDS else b"\n"
            ).join(blocks)
        return out or None

    return None, IOResult(rows=Rows(rows, render))
