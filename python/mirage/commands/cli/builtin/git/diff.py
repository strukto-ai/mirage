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
from collections.abc import Sequence
from dataclasses import replace

from dulwich.index import IndexEntry
from dulwich.repo import BaseRepo

from mirage.accessor.base import Accessor
from mirage.commands.cli.builtin.git.changes import (
    head_entries,
    staged_entries,
    work_entries,
)
from mirage.commands.cli.builtin.git.diff_output import (
    DiffFlags,
    compare,
    filtered,
    limited,
    parse_diff_flags,
    prefix_config,
    renames_enabled,
    render_changes,
    with_unmerged,
)
from mirage.commands.cli.builtin.git.errors import (
    GitError,
    InvalidOptionError,
    NoMergeBaseError,
    UsageError,
)
from mirage.commands.cli.builtin.git.index_file import (
    read_index,
    refuse_unresolved,
)
from mirage.commands.cli.builtin.git.io import exists
from mirage.commands.cli.builtin.git.pathspec import (
    absolute_operand,
    pathspec_patterns,
    pathspec_selects,
    pattern_roots,
    visible_path,
)
from mirage.commands.cli.builtin.git.repo import config_bool
from mirage.commands.cli.builtin.git.revparse import (
    merge_bases,
    range_commits,
    resolve_commit,
    resolve_object,
    tree_id,
)
from mirage.commands.cli.builtin.git.rows import (
    Delta,
    deltas,
    shown_sides,
)
from mirage.commands.cli.builtin.git.seen import shown_entries
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.tree import tree_entries
from mirage.commands.cli.builtin.git.types import IndexState, RepoLocation
from mirage.commands.cli.builtin.git.util import (
    STDERR,
    lone_help,
    option_operand,
    require_vfs,
    split_marked,
    start_point,
    verb_usage,
)
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult, Rows
from mirage.shell.bytes import decode_text
from mirage.types import PathSpec
from mirage.workspace.files import Files

# Deliberate divergence, verified against git 2.47.3 on a real
# repository. The patch is correct and applies cleanly, and file
# headers, mode lines, blob abbreviations and hunk function context
# match git exactly, but a hunk can still sit a line off where git's
# does (`@@ -3,6 +3,10 @@` against `@@ -4,6 +4,10 @@`): where a
# changed block could sit at more than one equivalent place, git picks
# its own, so a blank line can be attributed to the additions on one
# side and the context on the other. Closing this means matching that
# choice; until then do not claim byte parity for diff bodies. `log`,
# `log --oneline`, `show`'s header and `branch` ARE byte-identical.


Tree = dict[bytes, tuple[int, bytes]]

# What makes a word a pattern git reads as a path unseen.
WILDCARDS = "*?[\\"


def _sides(
    repo: BaseRepo, texts: tuple[str, ...]
) -> tuple[Tree | None, Tree | None, bytes]:
    """Resolve the two sides a diff compares, synchronously.

    No revision compares the index with the working tree, one compares
    that revision with it, and two compare them with each other.
    ``A..B`` is the two-revision form written as one operand, and
    ``A...B`` compares B with the merge base of the two, which is what
    a branch changed since it forked; with several bases git warns and
    takes the first (pinned against git 2.50).

    Runs on a worker thread, because resolving fetches through the
    dispatcher.

    Args:
        repo (BaseRepo): repository to read.
        texts (tuple[str, ...]): the revision operands.

    Returns:
        tuple: the old side's entries, None for the index; the new
            side's, None for the working tree; and any warning.
    """
    warning = b""
    ends = range_commits(repo, texts[0]) if len(texts) == 1 else None
    if ends is None:
        if not texts:
            return None, None, warning
        old = resolve_commit(repo, texts[0])
        if len(texts) == 1:
            return (
                shown_entries(repo, tree_entries(repo, old.tree)),
                None,
                warning,
            )
        new = resolve_commit(repo, texts[1])
    else:
        old, new, symmetric = ends
        if symmetric:
            bases = merge_bases(repo, old, new)
            if not bases:
                raise NoMergeBaseError(texts[0])
            old = bases[0]
            if len(bases) > 1:
                warning = (
                    f"warning: {texts[0]}: multiple merge bases, "
                    f"using {old.id.decode()}\n"
                ).encode()
    return (
        shown_entries(repo, tree_entries(repo, old.tree)),
        shown_entries(repo, tree_entries(repo, new.tree)),
        warning,
    )


def _base(repo: BaseRepo, texts: tuple[str, ...]) -> Tree:
    """The tree ``--cached`` compares the index with, synchronously.

    The named revision, HEAD by default, or the empty tree on an unborn
    branch.

    Args:
        repo (BaseRepo): repository to read.
        texts (tuple[str, ...]): optional base revision.
    """
    if len(texts) > 1:
        raise GitError("--cached accepts at most one revision")
    if texts:
        return shown_entries(
            repo, tree_entries(repo, resolve_commit(repo, texts[0]).tree)
        )
    return shown_entries(repo, head_entries(repo) or {})


def _output(
    repo: BaseRepo, before: Tree, after: Tree, flags: DiffFlags
) -> tuple[bytes, bool]:
    """Render what changed from one side's entries to the other's.

    Returns the output and whether anything differs, which ``--exit-code``
    answers with.

    Args:
        repo (BaseRepo): repository to read.
        before (Tree): the old side, path to (mode, id).
        after (Tree): the new side.
        flags (DiffFlags): output options.
    """
    rows = compare(repo, before, after, flags.renames)
    return (
        render_changes(repo, rows, flags),
        bool(filtered(with_unmerged(rows, flags), flags)),
    )


async def diff(
    accessor: Accessor, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    """Diff the working tree, staged content or commits.

    No revision compares the index with the working tree, and one
    compares that revision with it, as git does; two diff against each
    other. With --cached or --staged, compare the index with the named
    revision, HEAD by default, or the empty tree on an unborn branch.
    Operands after ``--`` are pathspecs, read once the revisions have
    resolved, as git reads them, and every format shows only the paths
    they name.

    Args:
        accessor (Accessor): git reaches no service.
        paths (list[PathSpec]): the path operands; git declares none.
        texts (list[str]): the operands.
        ctx (Context): the line's context; git reads its repository
            through ``ctx.vfs``.
    """
    vfs = require_vfs(ctx)
    fl = FlagView(ctx.flags)
    cached = fl.as_bool("cached") or fl.as_bool("staged")
    revisions, pathspecs = split_marked(tuple(texts), ctx.argv)
    word = option_operand(ctx, texts, STDERR)
    if word is not None and (
        cached or any(not text.startswith("-") for text in revisions)
    ):
        raise UsageError("", verb_usage(ctx))
    if word is not None:
        raise InvalidOptionError(word, verb_usage(ctx))
    repo, location = await opened(ctx, fl)
    parsed = parse_diff_flags(
        fl,
        default_renames=await renames_enabled(vfs, location),
        quote_path_fully=await config_bool(
            vfs, location, b"core", b"quotepath", True
        ),
        prefix_settings=await prefix_config(vfs, location),
    )
    warning = b""
    patterns = pathspec_patterns(location, start_point(fl).virtual, pathspecs)
    state_side: Tree = {}
    if cached:
        state = await read_index(vfs, location.gitdir)
        refuse_unresolved(state)
        before = await asyncio.to_thread(_base, repo, revisions)
        after = shown_entries(repo, staged_entries(state))
    else:
        old, new, warning = await asyncio.to_thread(_sides, repo, revisions)
        if new is None:
            state = await read_index(vfs, location.gitdir)
            after = await work_entries(
                vfs, repo, location, state, pattern_roots(patterns)
            )
            if old is None:
                for path in state.conflicts:
                    after.pop(path, None)
            state_side = shown_entries(repo, staged_entries(state))
            before = state_side if old is None else old
            parsed = replace(parsed, work_tree=True)
        else:
            before, after = old or {}, new
    return _compared(
        repo,
        location,
        replace(
            parsed,
            pathspecs=patterns,
            same_as_index=_same_as_index(state_side, after)
            if parsed.work_tree
            else frozenset(),
        ),
        (before, after),
        fl,
        warning,
    )


def _same_as_index(index: Tree, work: Tree) -> frozenset[bytes]:
    return frozenset(
        path for path, side in work.items() if index.get(path) == side
    )


def _compared(
    repo: BaseRepo,
    location: RepoLocation,
    parsed: DiffFlags,
    sides: tuple[Tree, Tree],
    fl: FlagView,
    warning: bytes = b"",
) -> tuple[ByteSource | None, IOResult]:
    """Answer one comparison: its rows, and exit 1 when asked to say
    whether anything differs.

    Args:
        repo (BaseRepo): repository to read.
        location (RepoLocation): the discovered repository.
        parsed (DiffFlags): the output options, pathspecs included.
        sides (tuple[Tree, Tree]): the old side and the new.
        fl (FlagView): parsed flags.
        warning (bytes): what to print on stderr first.
    """
    quiet = fl.as_bool("quiet")
    report = quiet or fl.as_bool("exit_code")
    patterns = parsed.pathspecs
    rows = deltas(
        location,
        [(limited(sides[0], patterns), limited(sides[1], patterns))],
    )

    async def render(shown: list[Delta]) -> ByteSource | None:
        [(old_side, new_side)] = shown_sides(shown, 1)
        body, differs = await asyncio.to_thread(
            _output, repo, old_side, new_side, parsed
        )
        if report and differs:
            io.exit_code = 1
        return None if quiet else body or None

    io = IOResult(stderr=warning if warning else None, rows=Rows(rows, render))
    return None, io


async def _path_operands(
    ctx: Context, fl: FlagView, repo: BaseRepo, words: tuple[str, ...]
) -> None:
    """Refuse a bare word a plumbing diff cannot read as a path.

    With no ``--`` a word that exists, or a pattern, is a path; one that
    names a revision is a misuse, and anything else is unknown.

    Args:
        ctx (Context): the line's context.
        fl (FlagView): parsed flags.
        repo (BaseRepo): the opened repository.
        words (tuple[str, ...]): the operands before any ``--``.

    Raises:
        UsageError: a word names a revision.
        AmbiguousArgumentError: a word names nothing.
    """
    vfs = require_vfs(ctx)
    start = start_point(fl).virtual
    for word in words:
        if any(char in word for char in WILDCARDS):
            continue
        if await exists(
            vfs, PathSpec.from_str_path(absolute_operand(start, word))
        ):
            continue
        await asyncio.to_thread(resolve_object, repo, word)
        raise UsageError("", verb_usage(ctx))


async def _plumbing_flags(
    fl: FlagView, vfs: Files, location: RepoLocation
) -> DiffFlags:
    return parse_diff_flags(
        fl,
        default_patch=False,
        porcelain=False,
        default_renames=False,
        quote_path_fully=await config_bool(
            vfs, location, b"core", b"quotepath", True
        ),
        prefix_settings=await prefix_config(vfs, location),
    )


def _unmerged_sides(
    location: RepoLocation,
    state: IndexState,
    patterns: Sequence[str],
    before: Tree,
    after: Tree,
) -> dict[
    bytes,
    tuple[
        tuple[int, bytes] | None,
        tuple[int, bytes] | None,
        tuple[int, bytes] | None,
    ],
]:
    """Each conflicted path's stages and work file, and the sides fitted.

    The index side of a conflict is its stage 2, which is what the
    ordinary row beside the ``U`` compares the file with; a path with no
    stage 2 has no such row.

    Args:
        location (RepoLocation): the discovered repository.
        state (IndexState): the parsed index.
        patterns (Sequence[str]): the pathspecs, empty for everything.
        before (Tree): the index side, filled in here.
        after (Tree): the working tree side, emptied of a path with no
            stage 2.
    """
    sides: dict[
        bytes,
        tuple[
            tuple[int, bytes] | None,
            tuple[int, bytes] | None,
            tuple[int, bytes] | None,
        ],
    ] = {}
    for path, conflict in state.conflicts.items():
        name = decode_text(path)
        if not visible_path(location, name):
            after.pop(path, None)
            continue
        ours = _stage_of(conflict.this)
        work = after.get(path)
        if not patterns or pathspec_selects(name, patterns):
            sides[path] = (ours, _stage_of(conflict.other), work)
        if ours is None:
            after.pop(path, None)
        else:
            before[path] = ours
    return sides


def _stage_of(entry: IndexEntry | None) -> tuple[int, bytes] | None:
    return None if entry is None else (entry.mode, entry.sha)


async def diff_files(
    accessor: Accessor, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    """Compare the index with the working tree, in plumbing's defaults.

    Args:
        accessor (Accessor): git reaches no service.
        paths (list[PathSpec]): the path operands; git declares none.
        texts (list[str]): the paths.
        ctx (Context): the line's context.
    """
    vfs = require_vfs(ctx)
    fl = FlagView(ctx.flags)
    if option_operand(ctx, texts, lone_help(ctx, texts)) is not None:
        raise UsageError("", verb_usage(ctx))
    words, marked = split_marked(tuple(texts), ctx.argv)
    repo, location = await opened(ctx, fl, work_tree=True)
    await _path_operands(ctx, fl, repo, words)
    parsed = await _plumbing_flags(fl, vfs, location)
    patterns = pathspec_patterns(
        location, start_point(fl).virtual, (*words, *marked)
    )
    state = await read_index(vfs, location.gitdir)
    after = await work_entries(
        vfs, repo, location, state, pattern_roots(patterns)
    )
    before = shown_entries(repo, staged_entries(state))
    unmerged = _unmerged_sides(location, state, patterns, before, after)
    return _compared(
        repo,
        location,
        replace(parsed, pathspecs=patterns, work_tree=True, unmerged=unmerged),
        (before, after),
        fl,
    )


async def diff_index(
    accessor: Accessor, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    """Compare a tree with the working tree, or with the index.

    A file staged and left alone reports the staged id; only one that
    differs from the index reports the all-zero id.

    Args:
        accessor (Accessor): git reaches no service.
        paths (list[PathSpec]): the path operands; git declares none.
        texts (list[str]): the tree-ish, then the paths.
        ctx (Context): the line's context.
    """
    vfs = require_vfs(ctx)
    fl = FlagView(ctx.flags)
    if option_operand(ctx, texts, lone_help(ctx, texts)) is not None:
        raise UsageError("", verb_usage(ctx))
    words, marked = split_marked(tuple(texts), ctx.argv)
    if not words:
        raise UsageError("", verb_usage(ctx))
    cached = fl.as_bool("cached")
    repo, location = await opened(ctx, fl, work_tree=not cached)
    tree = await asyncio.to_thread(tree_id, repo, words[0])
    await _path_operands(ctx, fl, repo, words[1:])
    parsed = await _plumbing_flags(fl, vfs, location)
    patterns = pathspec_patterns(
        location, start_point(fl).virtual, (*words[1:], *marked)
    )
    before = await asyncio.to_thread(
        lambda: shown_entries(repo, tree_entries(repo, tree))
    )
    state = await read_index(vfs, location.gitdir)
    staged = shown_entries(repo, staged_entries(state))
    if cached:
        return _compared(
            repo,
            location,
            replace(parsed, pathspecs=patterns),
            (before, staged),
            fl,
        )
    after = await work_entries(
        vfs, repo, location, state, pattern_roots(patterns)
    )
    if fl.as_bool("m"):
        after = {**staged, **after}
    return _compared(
        repo,
        location,
        replace(
            parsed,
            pathspecs=patterns,
            work_tree=True,
            same_as_index=_same_as_index(staged, after),
        ),
        (before, after),
        fl,
    )
