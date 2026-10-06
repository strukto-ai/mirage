import asyncio
import re
from dataclasses import replace

from mirage.commands.cli.builtin.git.diff import diff
from mirage.commands.cli.builtin.git.errors import GitError
from mirage.commands.cli.builtin.git.io import read_optional
from mirage.commands.cli.builtin.git.revparse import resolve_commit
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.util import fatal
from mirage.commands.cli.types import CLIDoors, CLIInvocation
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult


async def stash_list(
    inv: CLIInvocation[None],
) -> tuple[ByteSource | None, IOResult]:
    """List the stash reflog newest first, including stashes from real Git.

    Args:
        inv (CLIInvocation[None]): repository invocation.
    """
    try:
        doors = inv.doors or CLIDoors()
        _, location = await opened(FlagView(inv.flags), doors)
        assert doors.dispatch is not None
        data = await read_optional(
            doors.dispatch, location.commondir.join("logs/refs/stash")
        )
        lines = (data or b"").splitlines()
        text = b"".join(
            f"stash@{{{index}}}: ".encode() + row.split(b"\t", 1)[-1] + b"\n"
            for index, row in enumerate(reversed(lines))
        )
        return text, IOResult()
    except GitError as exc:
        return fatal(exc)


async def stash_show(
    inv: CLIInvocation[None],
) -> tuple[ByteSource | None, IOResult]:
    """Show a stash's working tree against its first parent, not HEAD.

    Args:
        inv (CLIInvocation[None]): optional stash selector and diff options.
    """
    try:
        doors = inv.doors or CLIDoors()
        repo, location = await opened(FlagView(inv.flags), doors)
        assert doors.dispatch is not None
        selector = inv.texts[0] if inv.texts else "stash@{0}"
        match = re.fullmatch(r"(?:stash@\{(\d+)\}|(\d+))", selector)
        if match is not None:
            data = await read_optional(
                doors.dispatch, location.commondir.join("logs/refs/stash")
            )
            rows = list(reversed((data or b"").splitlines()))
            index = int(match.group(1) or match.group(2))
            if not rows:
                return None, IOResult(
                    exit_code=1, stderr=b"No stash entries found.\n"
                )
            if index >= len(rows):
                raise GitError(f"log for 'stash' only has {len(rows)} entries")
            selector = rows[index].split(b" ", 2)[1].decode()
        commit = await asyncio.to_thread(resolve_commit, repo, selector)
        if len(commit.parents) < 2:
            raise GitError(f"'{selector}' is not a stash-like commit")
        flags = dict(inv.flags)
        view = FlagView(flags)
        if not any(
            view.as_bool(name)
            for name in (
                "patch",
                "name_only",
                "name_status",
                "stat",
                "numstat",
                "shortstat",
                "summary",
                "raw",
            )
        ):
            flags["stat"] = True
        return await diff(
            replace(
                inv,
                texts=(commit.parents[0].decode(), commit.id.decode()),
                flags=flags,
            )
        )
    except GitError as exc:
        return fatal(exc)
