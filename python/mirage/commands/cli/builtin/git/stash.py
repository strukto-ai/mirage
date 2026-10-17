import asyncio
import re
from dataclasses import replace

from mirage.commands.cli.builtin.git.diff import diff
from mirage.commands.cli.builtin.git.errors import GitError
from mirage.commands.cli.builtin.git.io import read_optional
from mirage.commands.cli.builtin.git.revparse import resolve_commit
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.util import fatal
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def stash_list(
    config: None, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    """List the stash reflog newest first, including stashes from real Git.

    Args:
        config (None): git declares no config_model.
        paths (list[PathSpec]): the path operands; git declares none.
        texts (list[str]): the operands.
        ctx (Context): the line's context.
    """
    try:
        _, location = await opened(ctx, FlagView(ctx.flags))
        assert ctx.vfs is not None
        data = await read_optional(
            ctx.vfs, location.commondir.join("logs/refs/stash")
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
    config: None, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    """Show a stash's working tree against its first parent, not HEAD.

    Args:
        config (None): git declares no config_model.
        paths (list[PathSpec]): the path operands; git declares none.
        texts (list[str]): the optional stash selector.
        ctx (Context): the line's context, with the diff options.
    """
    try:
        repo, location = await opened(ctx, FlagView(ctx.flags))
        assert ctx.vfs is not None
        selector = texts[0] if texts else "stash@{0}"
        match = re.fullmatch(r"(?:stash@\{(\d+)\}|(\d+))", selector)
        if match is not None:
            data = await read_optional(
                ctx.vfs, location.commondir.join("logs/refs/stash")
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
        flags = dict(ctx.flags)
        flag_view = FlagView(flags)
        if not any(
            flag_view.as_bool(name)
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
            config,
            paths,
            [commit.parents[0].decode(), commit.id.decode()],
            replace(ctx, flags=flags),
        )
    except GitError as exc:
        return fatal(exc)
