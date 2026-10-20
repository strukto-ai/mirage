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
    limited,
    parse_diff_flags,
    renames_enabled,
    render_changes,
)
from mirage.commands.cli.builtin.git.errors import (
    GitError,
    InvalidOptionError,
    NoMergeBaseError,
    NoWorkspaceError,
    UsageError,
)
from mirage.commands.cli.builtin.git.index_file import (
    read_index,
    refuse_unresolved,
)
from mirage.commands.cli.builtin.git.pathspec import pathspec_patterns
from mirage.commands.cli.builtin.git.repo import config_bool
from mirage.commands.cli.builtin.git.revparse import (
    merge_bases,
    range_commits,
    resolve_commit,
)
from mirage.commands.cli.builtin.git.rows import (
    Delta,
    deltas,
    shown_sides,
)
from mirage.commands.cli.builtin.git.seen import shown_entries
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.tree import tree_entries
from mirage.commands.cli.builtin.git.util import (
    STDERR,
    fatal,
    option_operand,
    split_marked,
    start_point,
    verb_usage,
)
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult, Rows
from mirage.types import PathSpec

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
) -> bytes:
    """Render what changed from one side's entries to the other's.

    Args:
        repo (BaseRepo): repository to read.
        before (Tree): the old side, path to (mode, id).
        after (Tree): the new side.
        flags (DiffFlags): output options.
    """
    return render_changes(
        repo, compare(repo, before, after, flags.renames), flags
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
    vfs = ctx.vfs
    fl = FlagView(ctx.flags)
    cached = fl.as_bool("cached") or fl.as_bool("staged")
    revisions, pathspecs = split_marked(tuple(texts), ctx.argv)
    try:
        if vfs is None:
            raise NoWorkspaceError()
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
        )
        warning = b""
        if cached:
            state = await read_index(vfs, location.gitdir)
            refuse_unresolved(state)
            before = await asyncio.to_thread(_base, repo, revisions)
            after = staged_entries(state)
        else:
            old, new, warning = await asyncio.to_thread(
                _sides, repo, revisions
            )
            if new is None:
                state = await read_index(vfs, location.gitdir)
                after = await work_entries(vfs, repo, location, state)
                if old is None:
                    for path in state.conflicts:
                        after.pop(path, None)
                before = staged_entries(state) if old is None else old
            else:
                before, after = old or {}, new
        patterns = pathspec_patterns(
            location, start_point(fl).virtual, pathspecs
        )
        parsed = replace(parsed, pathspecs=patterns)
        rows = deltas(
            location, [(limited(before, patterns), limited(after, patterns))]
        )
    except GitError as exc:
        return fatal(exc)

    async def render(shown: list[Delta]) -> ByteSource | None:
        [(old_side, new_side)] = shown_sides(shown, 1)
        body = await asyncio.to_thread(
            _output, repo, old_side, new_side, parsed
        )
        return yield_bytes(body) if body else None

    return None, IOResult(
        stderr=warning if warning else None, rows=Rows(rows, render)
    )
