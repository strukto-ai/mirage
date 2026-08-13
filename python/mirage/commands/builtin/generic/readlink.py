import posixpath
from collections.abc import Mapping
from dataclasses import dataclass

from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagValue, FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def readlink(
    paths: list[PathSpec],
    *,
    f: bool = False,
    e: bool = False,
    m: bool = False,
    n: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        raise ValueError("readlink: missing operand")
    normalize = f or e or m
    results: list[str] = []
    for p in paths:
        vp = p.virtual
        if normalize:
            vp = posixpath.normpath(vp)
        results.append(vp)
    text = "\n".join(results)
    if not n:
        text += "\n"
    return text.encode(), IOResult()


__all__ = ["readlink"]


@dataclass(frozen=True, slots=True)
class ReadlinkFlags:
    canonicalize: bool = False
    canonicalize_existing: bool = False
    canonicalize_missing: bool = False
    no_newline: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> ReadlinkFlags:
    fl = FlagView(flags, spec=SPECS["readlink"])
    return ReadlinkFlags(
        canonicalize=fl.as_bool("f"),
        canonicalize_existing=fl.as_bool("e"),
        canonicalize_missing=fl.as_bool("m"),
        no_newline=fl.as_bool("n"),
    )


async def readlink_generic(paths, texts, opts: CommandOpts):
    if not paths:
        raise ValueError("readlink: missing operand")
    parsed = parse_flags(opts.flags)
    return await readlink(paths,
                          f=parsed.canonicalize,
                          e=parsed.canonicalize_existing,
                          m=parsed.canonicalize_missing,
                          n=parsed.no_newline)
