# Refusal wording and exit codes from Info-ZIP UnZip 6.00 (Info-ZIP
# license; see licenses/third_party/info-zip.txt).

from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType

from mirage.commands.builtin.generic.archive.extract import extract_dest
from mirage.commands.builtin.utils.stream_host import (
    StreamHost,
    hosted_stream,
)
from mirage.commands.config import Context
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.constants import OPERAND
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.standard import version_line
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult
from mirage.runtime.types import DispatchFn
from mirage.shell.bytes import byte_view
from mirage.types import JsonValue, PathSpec, ReadStreamFn

# Info-ZIP answers an option it does not know with its usage block and
# exit 10; -1, -2, -s, -m and -h are zipinfo's letters and mean nothing to
# unzip proper (Info-ZIP's `unzip -h` is its help screen).
USAGE_EXIT = 10
ZIPINFO_LETTERS = ("1", "2", "s", "m", "h")
# The letters mirage-rs reads, by the flag each one is.
LETTERS = {
    "l": "args_l",
    "v": "v",
    "t": "t",
    "p": "p",
    "Z": "Z",
    "1": "args_1",
    "2": "2",
    "s": "s",
    "m": "m",
    "h": "h",
    "o": "o",
    "n": "n",
}


@dataclass(frozen=True, slots=True)
class UnzipFlags:
    letters: Mapping[str, bool]
    quiet: int = 0
    dest: PathSpec | str | None = None
    excludes: tuple[str, ...] = ()


def parse_flags(flags: Mapping[str, FlagValue]) -> UnzipFlags:
    fl = FlagView(flags, spec=SPECS["unzip"])
    dest = fl.raw("d")
    return UnzipFlags(
        letters=MappingProxyType(
            {key: fl.as_bool(flag) for key, flag in LETTERS.items()}
        ),
        quiet=fl.as_int("q", 0),
        dest=dest if isinstance(dest, (PathSpec, str)) else None,
        excludes=tuple(fl.as_list("x")),
    )


def _patterns(
    flags: Mapping[str, FlagValue], texts: list[str], excludes: tuple[str, ...]
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """The member patterns and the ``-x`` patterns, as Info-ZIP reads them.

    ``-x`` takes every operand typed after it, up to a ``-d``, so the
    operands are placed by where the flag tape recorded them; the first
    is the archive. A line whose operands the tape does not account for
    keeps one pattern per ``-x``.

    Args:
        flags (Mapping[str, FlagValue]): the parsed flag bag.
        texts (list[str]): the operands after the archive.
        excludes (tuple[str, ...]): every ``-x`` value, in order.
    """
    tape = FlagView(flags, spec=SPECS["unzip"]).occurrences("x", "d", OPERAND)
    if sum(name == OPERAND for name, _ in tape) != len(texts) + 1:
        return tuple(texts), excludes
    members: list[str] = []
    excluded: list[str] = []
    listing = False
    index = -1
    for name, value in tape:
        if name == OPERAND:
            if index >= 0:
                (excluded if listing else members).append(texts[index])
            index += 1
        elif name == "x" and isinstance(value, str):
            excluded.append(value)
            listing = True
        elif name == "d":
            listing = False
    return tuple(members), tuple(excluded)


async def unzip_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    stream: ReadStreamFn,
    dispatch: DispatchFn | None,
) -> tuple[ByteSource | None, IOResult]:
    """List, test, pipe or extract an archive through mirage-rs's unzip,
    which reads it from a host spool and writes each member where ``-d``
    or the working directory says, on whichever mount owns it.

    Args:
        paths (list[PathSpec]): the archive.
        texts (list[str]): Info-ZIP member filespecs, as typed.
        ctx (Context): the command's context.
        stream (ReadStreamFn): reads the archive.
        dispatch (DispatchFn | None): stats, makes and writes what
            extraction reaches.
    """
    parsed = parse_flags(ctx.flags)
    letters = parsed.letters
    if not paths:
        # Info-ZIP answers -v without an archive with its version banner,
        # and mirage's version line is that banner here.
        if letters["v"]:
            return version_line("unzip"), IOResult()
        raise ValueError("unzip: missing operand")
    if not letters["Z"]:
        for letter in ZIPINFO_LETTERS:
            if letters[letter]:
                raise UsageError(
                    f"unzip: -{letter} is a ZipInfo option and needs -Z",
                    exit_code=USAGE_EXIT,
                )
    archive = paths[0]
    members, excludes = _patterns(ctx.flags, texts, parsed.excludes)
    dest = parsed.dest
    config: dict[str, JsonValue] = {
        "archive": byte_view(archive.raw_path),
        "members": [byte_view(member) for member in members],
        "excludes": [byte_view(pattern) for pattern in excludes],
        "base": byte_view(extract_dest(dest, ctx.cwd, True).rstrip("/")),
        "q": parsed.quiet,
        **letters,
    }
    if dest is not None:
        typed = dest.raw_path if isinstance(dest, PathSpec) else dest
        config["dest"] = byte_view(typed)
    host = StreamHost(
        [archive], stream, ctx.stdin, dispatch, ctx.cwd, dash=False
    )
    io = IOResult()
    return hosted_stream("unzip", config, host, io), io


__all__ = ["unzip_generic"]
