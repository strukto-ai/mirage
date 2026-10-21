import asyncio
from dataclasses import replace

from dulwich.repo import BaseRepo

from mirage.accessor.base import Accessor
from mirage.commands.cli.builtin.git.errors import (
    ShortlogOptionError,
)
from mirage.commands.cli.builtin.git.format import subject
from mirage.commands.cli.builtin.git.history import (
    LogFlags,
    parse_flags,
    ref_commits,
    select,
    walk_ends,
    walk_operands,
)
from mirage.commands.cli.builtin.git.mailmap import (
    load_mailmap,
    mapped_identity,
)
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.types import MailmapEntry
from mirage.commands.cli.builtin.git.util import (
    option_operand,
    verb_usage,
)
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _summary(
    repo: BaseRepo,
    revisions: tuple[str, ...],
    flags: LogFlags,
    email: bool,
    numbered: bool,
    summary: bool,
    mailmap: tuple[MailmapEntry, ...],
    dashed: bool = False,
) -> bytes:
    """Group selected commits by author.

    Args:
        repo (BaseRepo): repository to read.
        revisions (tuple[str, ...]): revisions or ranges to walk.
        flags (LogFlags): history selection.
        email (bool): include the email in each author identity.
        numbered (bool): sort by descending commit count.
        summary (bool): omit commit subjects.
        mailmap (tuple[MailmapEntry, ...]): the identities to map.
        dashed (bool): whether ``--`` is on the line.
    """
    starts, hidden = walk_ends(
        repo, revisions or (() if flags.all_refs else ("HEAD",)), dashed
    )
    if flags.all_refs:
        starts.extend(ref_commits(repo))
    groups: dict[str, list[str]] = {}
    for commit in reversed(select(repo, starts, flags, tuple(hidden))):
        identity = mapped_identity(
            commit.author.decode("utf-8", "replace"), mailmap
        )
        if not email:
            identity = identity.rsplit(" <", 1)[0]
        groups.setdefault(identity, []).append(subject(commit))
    names = sorted(
        groups, key=lambda name: (-len(groups[name]) if numbered else 0, name)
    )
    return "".join(
        f"{len(groups[name]):6}\t{name}\n"
        if summary
        else f"{name} ({len(groups[name])}):\n"
        + "".join(f"      {message}\n" for message in groups[name])
        + "\n"
        for name in names
    ).encode()


async def shortlog(
    accessor: Accessor, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    """Summarize repository history by author.

    Args:
        accessor (Accessor): git reaches no service.
        paths (list[PathSpec]): the path operands; git declares none.
        texts (list[str]): the operands.
        ctx (Context): the line's context.
    """
    fl = FlagView(ctx.flags)
    word = option_operand(ctx, texts)
    if word is not None:
        raise ShortlogOptionError(word, verb_usage(ctx))
    repo, location = await opened(ctx, fl)
    assert ctx.vfs is not None
    mailmap = await load_mailmap(ctx.vfs, location)
    revisions, patterns, dashed = await walk_operands(
        ctx, fl, repo, location, texts
    )
    out = await asyncio.to_thread(
        _summary,
        repo,
        revisions,
        replace(parse_flags(fl), pathspecs=patterns),
        fl.as_bool("email"),
        fl.as_bool("numbered"),
        fl.as_bool("summary"),
        mailmap,
        dashed,
    )
    return out, IOResult()
