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
from dataclasses import dataclass, replace

from dulwich.objects import Blob, Commit, ObjectID, ShaFile, Tag, Tree
from dulwich.repo import BaseRepo

from mirage.accessor.base import Accessor
from mirage.commands.cli.builtin.git.constants import (
    HEAD,
    TERMINATED_KINDS,
    TREE,
)
from mirage.commands.cli.builtin.git.dates import (
    date_clock,
    parse_date_mode,
    show_date,
)
from mirage.commands.cli.builtin.git.diff_output import (
    DiffFlags,
    commit_deltas,
    commit_entry,
    commit_output,
    commit_shown,
    commit_sides,
    parse_diff_flags,
    renames_enabled,
)
from mirage.commands.cli.builtin.git.errors import (
    UsageError,
)
from mirage.commands.cli.builtin.git.format import (
    DEFAULT_DATE,
    LogFormat,
)
from mirage.commands.cli.builtin.git.history import (
    decorations,
    displayed,
    pretty_format,
)
from mirage.commands.cli.builtin.git.pathspec import pathspec_patterns
from mirage.commands.cli.builtin.git.ref_fields import ident_date
from mirage.commands.cli.builtin.git.repo import config_bool
from mirage.commands.cli.builtin.git.revparse import (
    resolve_commit,
    resolve_object,
)
from mirage.commands.cli.builtin.git.rows import (
    Delta,
    Side,
    deltas,
    shown_sides,
)
from mirage.commands.cli.builtin.git.seen import (
    located,
    place_named,
    shown_items,
)
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.types import (
    DateMode,
    Decoration,
    MailmapEntry,
)
from mirage.commands.cli.builtin.git.util import (
    check_operands,
    option_operand,
    require_vfs,
    revision_arg,
    split_marked,
    start_point,
    verb_usage,
)
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult, Rows
from mirage.shell.bytes import encode_text
from mirage.types import PathSpec


@dataclass(frozen=True, slots=True)
class ShowFlags:
    """The commit presentation and shared diff options.

    Args:
        diff (DiffFlags): the diff options.
        pretty (LogFormat): how the commit renders.
        abbrev_commit (bool): print an abbreviated id, which
            ``--oneline`` implies and ``--pretty=oneline`` alone does
            not.
        date (DateMode): how dates render.
        mailmap (tuple[MailmapEntry, ...]): the worktree ``.mailmap``.
        use_mailmap (bool): map the header identities.
        decorate (Decoration): how the commit is labelled with its refs;
            parse_show_flags leaves it off, and ``decoration_for``
            settles it once the repository's config can be read.
    """

    diff: DiffFlags
    pretty: LogFormat
    abbrev_commit: bool = False
    date: DateMode = DEFAULT_DATE
    mailmap: tuple[MailmapEntry, ...] = ()
    use_mailmap: bool = True
    decorate: Decoration = Decoration.NONE


def parse_show_flags(
    fl: FlagView,
    default_renames: bool = True,
    quote_path_fully: bool = True,
    env: Mapping[str, str] | None = None,
) -> ShowFlags:
    """Read the raw show flag kwargs into a frozen struct.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
        default_renames (bool): ``diff.renames``.
        quote_path_fully (bool): ``core.quotePath``.
        env (Mapping[str, str] | None): the command environment, for the
            clock dates are rendered by.
    """
    pretty = pretty_format(fl)
    return ShowFlags(
        diff=parse_diff_flags(
            fl,
            default_merge="dense-combined",
            default_renames=default_renames,
            quote_path_fully=quote_path_fully,
        ),
        date=parse_date_mode(fl.as_str("date", "default"), date_clock(env)),
        pretty=pretty,
        abbrev_commit=fl.as_bool("oneline"),
    )


def _tagger_lines(ident: str, flags: ShowFlags) -> str:
    """The tagger as the format shows a person: nothing for oneline, the
    date under medium, ``TaggerDate`` under fuller, and the name alone
    otherwise.

    Args:
        ident (str): the tag's ``tagger`` header value.
        flags (ShowFlags): the parsed invocation.
    """
    kind = flags.pretty.kind
    marker = ident.find(" <")
    close = ident.find(">", max(marker, 0))
    date = ident_date(ident)
    if kind == "oneline" or marker == -1 or close == -1 or date is None:
        return ""
    who = ident[: close + 1]
    when = show_date(date[0], date[1], flags.date)
    if kind == "medium":
        return f"Tagger: {who}\nDate:   {when}\n"
    if kind == "fuller":
        return f"Tagger:     {who}\nTaggerDate: {when}\n"
    return f"Tagger: {who}\n"


def _tag_block(
    repo: BaseRepo, tag: Tag, flags: ShowFlags
) -> tuple[str, ShaFile]:
    """What ``git show`` prints for an annotated tag ahead of the object
    it points at, and that object.

    ``tag <name>``, the tagger, then the rest of the tag from its blank
    line on, which is its message as written, signature and all. Pinned
    against git 2.50.1.

    Args:
        repo (BaseRepo): repository to read.
        tag (Tag): the annotated tag.
        flags (ShowFlags): the parsed invocation.
    """
    text = tag.as_raw_string().decode("utf-8", "surrogateescape")
    end = text.find("\n\n")
    fields = (text if end == -1 else text[:end]).split("\n")

    def value(key: str) -> str:
        return next(
            (
                line[len(key) + 1 :]
                for line in fields
                if line.startswith(f"{key} ")
            ),
            "",
        )

    block = f"tag {value('tag')}\n{_tagger_lines(value('tagger'), flags)}"
    target = repo.object_store[ObjectID(value("object").encode())]
    return block + ("" if end == -1 else text[end + 1 :]), target


def _commits(
    repo: BaseRepo,
    objects: list[tuple[str, ShaFile]],
    flags: ShowFlags,
) -> list[Commit]:
    """Every commit a line shows the diff of, tags peeled, synchronously.

    Args:
        repo (BaseRepo): repository to read.
        objects (list[tuple[str, ShaFile]]): each name as typed and the
            object it resolved to.
        flags (ShowFlags): the parsed invocation.
    """
    found = []
    for _name, obj in objects:
        target = obj
        while isinstance(target, Tag):
            _block, target = _tag_block(repo, target, flags)
        if isinstance(target, Commit):
            found.append(target)
    return found


def _render(
    repo: BaseRepo,
    objects: list[tuple[str, ShaFile]],
    flags: ShowFlags,
    sides: dict[bytes, list[Side]],
) -> bytes:
    """Render every resolved object a line names, synchronously.

    Runs on a worker thread: peeling, walking the tree and reading
    blobs all fetch through the dispatcher, so this must not sit on the
    loop that answers those fetches. A blank line goes ahead of every
    tag and tree but the first thing shown, and ahead of every later
    commit unless the format ends each entry itself (oneline, tformat);
    a blob takes none and counts for none, and a commit named twice
    prints once.

    Args:
        repo (BaseRepo): repository to read.
        objects (list[tuple[str, ShaFile]]): each name as typed and the
            object it resolved to.
        flags (ShowFlags): the parsed invocation.
        sides (dict[bytes, list[Side]]): each commit's comparisons, as
            the session sees them.
    """
    decor = decorations(repo, flags.decorate)
    terminated = flags.pretty.kind in TERMINATED_KINDS
    parts: list[bytes] = []
    shown_commits: set[bytes] = set()
    shown_one = False
    for name, obj in objects:
        target = obj
        tagged = isinstance(target, Tag)
        while isinstance(target, Tag):
            block, target = _tag_block(repo, target, flags)
            parts.append(encode_text(("\n" if shown_one else "") + block))
            shown_one = True
        # A tag can point past every commit at a tree or a blob, which
        # is shown only where the session sees it.
        if tagged and located(repo, target) is None:
            continue
        if isinstance(target, Blob):
            parts.append(target.data)
        elif isinstance(target, Tree):
            parts.append(
                (b"\n" if shown_one else b"")
                + f"tree {name}\n\n".encode()
                + b"".join(
                    entry + (b"/" if mode == TREE else b"") + b"\n"
                    for entry, mode, _ in shown_items(
                        repo, target, place_named(repo, name, target.id)
                    )
                )
            )
            shown_one = True
        elif isinstance(target, Commit) and target.id not in shown_commits:
            shown_commits.add(target.id)
            entry = commit_entry(
                repo,
                target,
                flags,
                flags.diff,
                sides[target.id],
                decor,
                flags.diff.summary
                and not flags.diff.no_patch
                and flags.pretty.kind != "oneline",
            )
            parts.append(
                (b"\n" if shown_one and not terminated else b"") + entry
            )
            shown_one = True
    return b"".join(parts)


async def show(
    accessor: Accessor, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    """Show each object a line names, in order.

    A commit as its log entry and its diff against its parent, an
    annotated tag as its own block ahead of what it points at, a tree as
    its listing and a blob as its bytes. Every name resolves before
    anything prints (pinned against git 2.50.1).

    Operands after ``--`` are pathspecs, read once the revisions have
    resolved, as git reads them; they limit the diff to the paths they
    name.

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
    revisions, pathspecs = split_marked(tuple(texts), ctx.argv)
    repo, location = await opened(ctx, fl)
    parsed = parse_show_flags(
        fl,
        await renames_enabled(vfs, location),
        await config_bool(vfs, location, b"core", b"quotepath", True),
        ctx.env,
    )
    mailmap, mapped, decorate = await displayed(
        vfs, location, fl, parsed.pretty
    )
    parsed = replace(
        parsed, mailmap=mailmap, use_mailmap=mapped, decorate=decorate
    )
    objects = [
        (name, await asyncio.to_thread(resolve_object, repo, name))
        for name in revisions or (HEAD,)
    ]
    parsed = replace(
        parsed,
        diff=replace(
            parsed.diff,
            pathspecs=pathspec_patterns(
                location, start_point(fl).virtual, pathspecs
            ),
        ),
    )
    commits = await asyncio.to_thread(_commits, repo, objects, parsed)
    rows, spans = await asyncio.to_thread(
        commit_deltas, repo, location, commits, parsed.diff
    )

    async def render(shown: list[Delta]) -> ByteSource | None:
        rendered = await asyncio.to_thread(
            _render, repo, objects, parsed, commit_shown(shown, spans)
        )
        return rendered

    return None, IOResult(rows=Rows(rows, render))


def _diff_tree(
    repo: BaseRepo,
    commit: Commit,
    flags: DiffFlags,
    no_commit_id: bool,
    sides: list[Side],
) -> bytes:
    """A resolved commit's diff against its parents, synchronously.

    Every block opens with the commit id unless ``--no-commit-id``, and a
    parent the commit does not differ from prints nothing, id included.

    Args:
        repo (BaseRepo): repository to read.
        commit (Commit): the commit to compare.
        flags (DiffFlags): the parsed diff flags.
        no_commit_id (bool): whether to leave the commit id out.
        sides (list[Side]): its comparisons, as the session sees them.
    """
    bodies = commit_output(repo, commit, flags, sides)
    return b"".join(
        (b"" if no_commit_id else commit.id + b"\n") + body
        for body in bodies
        if body is not None
    )


async def diff_tree(
    accessor: Accessor, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    """Compare a commit with its parents.

    Operands after ``--`` are pathspecs, read once the commit has
    resolved; they limit every block to the paths they name.

    Args:
        accessor (Accessor): git reaches no service.
        paths (list[PathSpec]): the path operands; git declares none.
        texts (list[str]): the operands.
        ctx (Context): the line's context.
    """
    fl = FlagView(ctx.flags)
    vfs = require_vfs(ctx)
    if option_operand(ctx, texts) is not None:
        raise UsageError("", verb_usage(ctx))
    repo, location = await opened(ctx, fl)
    fully = await config_bool(vfs, location, b"core", b"quotepath", True)
    parsed = parse_diff_flags(
        fl,
        default_patch=False,
        porcelain=False,
        quote_path_fully=fully,
    )
    revisions, pathspecs = split_marked(tuple(texts), ctx.argv)
    commit = await asyncio.to_thread(
        resolve_commit, repo, revision_arg(revisions)
    )
    parsed = replace(
        parsed,
        pathspecs=pathspec_patterns(
            location, start_point(fl).virtual, pathspecs
        ),
    )
    sides = await asyncio.to_thread(
        commit_sides, repo, commit, parsed, fl.as_bool("r"), False
    )
    rows = deltas(location, sides)

    async def render(shown: list[Delta]) -> ByteSource | None:
        return await asyncio.to_thread(
            _diff_tree,
            repo,
            commit,
            parsed,
            fl.as_bool("no_commit_id"),
            shown_sides(shown, len(sides)),
        )

    return None, IOResult(rows=Rows(rows, render))
