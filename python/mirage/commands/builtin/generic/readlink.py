import posixpath
from collections.abc import Mapping
from dataclasses import dataclass

from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.commands.spec.usage import missing_operand_error
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@dataclass(frozen=True, slots=True)
class ReadlinkFlags:
    canonicalize: bool = False
    canonicalize_existing: bool = False
    canonicalize_missing: bool = False
    no_newline: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> ReadlinkFlags:
    fl = FlagView(flags, spec=SPECS["readlink"])
    return ReadlinkFlags(
        canonicalize=fl.as_bool("canonicalize"),
        canonicalize_existing=fl.as_bool("canonicalize_existing"),
        canonicalize_missing=fl.as_bool("canonicalize_missing"),
        no_newline=fl.as_bool("no_newline"),
    )


async def readlink_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        raise missing_operand_error("readlink", None)
    parsed = parse_flags(ctx.flags)
    normalize = (
        parsed.canonicalize
        or parsed.canonicalize_existing
        or parsed.canonicalize_missing
    )
    text = "\n".join(
        posixpath.normpath(p.virtual) if normalize else p.virtual
        for p in paths
    )
    if not parsed.no_newline:
        text += "\n"
    return text.encode(), IOResult()
