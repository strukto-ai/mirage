import asyncio

from dulwich.repo import BaseRepo

from mirage.commands.cli.builtin.git.errors import (
    GitError,
    ShortlogOptionError,
)
from mirage.commands.cli.builtin.git.format import subject
from mirage.commands.cli.builtin.git.history import (
    LogFlags,
    parse_flags,
    ref_commits,
    select,
)
from mirage.commands.cli.builtin.git.mailmap import (
    load_mailmap,
    mapped_identity,
)
from mirage.commands.cli.builtin.git.revparse import split_revisions
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.types import MailmapEntry
from mirage.commands.cli.builtin.git.util import (
    fatal,
    option_operand,
    verb_usage,
)
from mirage.commands.cli.types import CLIDoors, CLIInvocation
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult


def _summary(
    repo: BaseRepo,
    revisions: tuple[str, ...],
    flags: LogFlags,
    email: bool,
    numbered: bool,
    summary: bool,
    mailmap: tuple[MailmapEntry, ...],
) -> bytes:
    """Group selected commits by author.

    Args:
        repo (BaseRepo): repository to read.
        revisions (tuple[str, ...]): revisions or ranges to walk.
        flags (LogFlags): history selection.
        email (bool): include the email in each author identity.
        numbered (bool): sort by descending commit count.
        summary (bool): omit commit subjects.
    """
    starts, hidden = split_revisions(
        repo, revisions or (() if flags.all_refs else ("HEAD",))
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
    inv: CLIInvocation[None],
) -> tuple[ByteSource | None, IOResult]:
    """Summarize repository history by author.

    Args:
        inv (CLIInvocation[None]): the parsed invocation.
    """
    fl = FlagView(inv.flags)
    try:
        word = option_operand(inv, inv.texts)
        if word is not None:
            raise ShortlogOptionError(word, verb_usage(inv))
        doors = inv.doors or CLIDoors()
        repo, location = await opened(fl, doors)
        assert doors.dispatch is not None
        mailmap = await load_mailmap(doors.dispatch, location)
        out = await asyncio.to_thread(
            _summary,
            repo,
            tuple(inv.texts),
            parse_flags(fl),
            fl.as_bool("email"),
            fl.as_bool("numbered"),
            fl.as_bool("summary"),
            mailmap,
        )
        return out, IOResult()
    except GitError as exc:
        return fatal(exc)
