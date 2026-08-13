import logging
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.constants import MIME_SYMLINK
from mirage.commands.builtin.file_helper import _detect, format_file_result
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagValue, FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.ops.types import LinkView
from mirage.types import LINK_TARGET_KEY, FileStat, FileType, PathSpec
from mirage.utils.path import CycleError

_logger = logging.getLogger(__name__)


# GNU `file -i` reports a symlink by its inode type, never by whatever
# the target would have sniffed as.
async def _link_description(path: PathSpec, links: LinkView) -> str | None:
    """How ``file`` describes a symlink operand, or None if it is not one.

    GNU names the target verbatim as it was stored, and calls the link
    broken when the target does not resolve to anything. A cycle counts
    as broken: nothing is reachable through it either.

    Args:
        path (PathSpec): the operand being described.
        links (LinkView): the namespace's symlink facts.
    """
    row = links.stat_at(path.virtual)
    if row is None:
        return None
    target = row.extra.get(LINK_TARGET_KEY, "")
    try:
        resolved = links.resolve(path.virtual)
    except CycleError:
        return f"broken symbolic link to {target}"
    if not await links.exists(resolved):
        return f"broken symbolic link to {target}"
    return f"symbolic link to {target}"


async def file_cmd(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    stat_fn: Callable[..., Awaitable[FileStat]],
    b: bool = False,
    i: bool = False,
    links: LinkView | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Describe each operand's content type, GNU file semantics.

    Args:
        paths (list[PathSpec]): operands to describe.
        read_bytes (Callable): backend reader, for the content sniff.
        stat_fn (Callable): backend stat.
        b (bool): brief, omit the filename column. GNU always names the
            operand exactly as typed, never a resolved or absolutised
            form, so every row is labelled with ``raw_path``.
        i (bool): report a MIME type instead of a description.
        links (LinkView | None): the namespace's symlink facts. Without
            -L the operand arrives unfollowed, so a link is described as
            a link rather than sniffed as its target.
    """
    if not paths:
        raise ValueError("file: missing operand")
    lines: list[str] = []
    for p in paths:
        if links is not None:
            described = await _link_description(p, links)
            if described is not None:
                lines.append(
                    format_file_result(p.raw_path,
                                       MIME_SYMLINK if i else described, b,
                                       False))
                continue
        s = await stat_fn(p)
        if s.type == FileType.DIRECTORY:
            lines.append(
                format_file_result(p.raw_path, FileType.DIRECTORY, b, i))
            continue
        try:
            header = (await read_bytes(p))[:512]
        except Exception as exc:
            _logger.debug("file: failed to read header for %s: %s", p.virtual,
                          exc)
            header = b""
        result = _detect(p.virtual, header, s)
        lines.append(format_file_result(p.raw_path, result, b, i))
    return format_records(lines), IOResult()


__all__ = ["file_cmd"]


@dataclass(frozen=True, slots=True)
class FileFlags:
    brief: bool = False
    mime: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> FileFlags:
    fl = FlagView(flags, spec=SPECS["file"])
    return FileFlags(brief=fl.as_bool("b"), mime=fl.as_bool("i"))


async def file_generic(paths, texts, opts: CommandOpts, read_bytes, stat_fn):
    parsed = parse_flags(opts.flags)
    return await file_cmd(paths,
                          read_bytes=read_bytes,
                          stat_fn=stat_fn,
                          b=parsed.brief,
                          i=parsed.mime,
                          links=opts.ns.links if opts.ns is not None else None)
