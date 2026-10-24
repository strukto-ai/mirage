import json
import posixpath
import re
from collections.abc import (
    AsyncIterator,
    Awaitable,
    Callable,
    Mapping,
    Sequence,
)
from contextlib import aclosing
from dataclasses import dataclass

from mirage.commands.builtin.constants import SED_MISSING_SCRIPT
from mirage.commands.builtin.utils.links import dispatch_of
from mirage.commands.builtin.utils.operands import normalized_read
from mirage.commands.builtin.utils.stream import is_stdin
from mirage.commands.builtin.utils.stream_host import StreamHost
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import fs_strerror
from mirage.errors.posix import posix_phrase
from mirage.errors.types import FsCondition
from mirage.io.stream import drain
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.rs.stream import open_stream, serve_requests
from mirage.shell.bytes import byte_view, encode_text, utf8_locale
from mirage.types import JsonValue, PathSpec, PolymorphicReadFn

SED_LINE_LENGTH = 70


def _line_length(raw: str | None) -> int:
    """GNU's atoi over -l.

    Leading blanks, a sign, digits. The value stops at the largest long
    and keeps its low 32 bits as an int, so ``-l 4294967297`` is 1. A
    negative length never folds, the same as 0.

    Args:
        raw (str | None): the -l value.
    """
    if raw is None:
        return SED_LINE_LENGTH
    m = re.match(r"\s*([+-]?)(\d*)", raw)
    if m is None or not m.group(2) or m.group(1) == "-":
        return 0
    # Twenty digits already pass the largest long.
    digits = m.group(2).lstrip("0")[:20] or "0"
    width = min(int(digits), (1 << 63) - 1) & 0xFFFFFFFF
    return 0 if width >> 31 else width


def _served_here(path: PathSpec) -> bool:
    """Every operand reads through the mount sed runs on, which resolved
    it.

    Args:
        path (PathSpec): the operand.
    """
    return True


def _failed(stderr: str, exit_code: int) -> tuple[None, IOResult]:
    return None, IOResult(exit_code=exit_code, stderr=encode_text(stderr))


async def _sed_stream(
    config: Mapping[str, JsonValue], host: StreamHost, io: IOResult
) -> AsyncIterator[bytes]:
    """Run the script, yielding its output as it settles; output closed
    early still lets what the script wrote to its files land. The engine
    opens on the first pull, so output closed before one holds none.

    Args:
        config (Mapping[str, JsonValue]): the sed engine's configuration.
        host (StreamHost): serves the inputs and files it reaches.
        io (IOResult): receives the exit status and stderr.
    """
    engine = open_stream("sed", config)
    try:
        async with aclosing(serve_requests(engine, host)) as output:
            async for chunk in output:
                yield chunk
    except GeneratorExit:
        if engine.cancel():
            await drain(serve_requests(engine, host))
        raise
    finally:
        io.exit_code = engine.status()
        io.stderr = await host.errors.output()
        await host.close()


@dataclass(frozen=True, slots=True)
class SedFlags:
    in_place: bool = False
    suppress: bool = False
    extended: bool = False
    separate: bool = False
    line_length: int = SED_LINE_LENGTH
    scripts: tuple[str | PathSpec, ...] = ()


def parse_flags(flags: Mapping[str, FlagValue]) -> SedFlags:
    fl = FlagView(flags, spec=SPECS["sed"])
    expressions = iter(fl.as_list("e"))
    files = iter(fl.as_paths("f"))
    return SedFlags(
        in_place=fl.as_bool("i"),
        suppress=fl.as_bool("n"),
        extended=fl.as_bool("E") or fl.as_bool("r"),
        separate=fl.as_bool("separate"),
        line_length=_line_length(fl.as_str("line_length")),
        scripts=tuple(
            next(expressions) if name == "e" else next(files)
            for name, _ in fl.occurrences("e", "f")
        ),
    )


def sed_writes(flags: Mapping[str, FlagValue], texts: Sequence[str]) -> bool:
    """Whether a sed line may change files: under ``-i``, with a script
    file (its text is read only when sed runs), or when its script names
    a ``w`` file, which GNU opens even when it then refuses the script.

    Args:
        flags (Mapping[str, FlagValue]): the flags as the line's parse
            reads them, before any path value is resolved.
        texts (Sequence[str]): the line's text operands; the first is the
            script when no ``-e`` or ``-f`` gave one.
    """
    fl = FlagView(flags, spec=SPECS["sed"])
    if fl.as_bool("i") or fl.raw("f") is not None:
        return True
    scripts = fl.as_list("e") or list(texts[:1])
    if not scripts:
        return False
    engine = open_stream(
        "sed",
        {
            "pieces": [{"text": byte_view(script)} for script in scripts],
            "extended": fl.as_bool("E") or fl.as_bool("r"),
        },
    )
    return bool(json.loads(engine.metadata())["writes"])


def _script_origins(
    argv: Sequence[str], count: int
) -> list[str | None] | None:
    """Which -e/-f occurrences of the line were script files.

    With their names as spelled, for GNU's ``file NAME line N:``
    diagnostics. The executor reads a script file before sed runs and
    hands its text on as one more -e (so every sub-run of a fanned-out
    line sees the same program), which leaves only the line's own words to
    tell the two apart. None for an expression; the whole answer is None
    when the words are not the line's (a split run) or do not account for
    every occurrence.

    Args:
        argv (Sequence[str]): the words after ``sed``.
        count (int): how many -e/-f occurrences the flags hold.
    """
    if not argv:
        return None
    out: list[str | None] = []
    i = 0
    while i < len(argv):
        word = argv[i]
        i += 1
        if word == "--":
            break
        if word.startswith("--"):
            if word == "--line-length":
                i += 1
            continue
        if not word.startswith("-") or word == "-":
            continue
        for j in range(1, len(word)):
            c = word[j]
            if c not in "efl":
                continue
            value = word[j + 1 :]
            if not value:
                value = argv[i] if i < len(argv) else ""
                i += 1
            if c != "l":
                out.append(value if c == "f" else None)
            break
    return out if len(out) == count else None


def _positional_as_paths(
    texts: list[str], cwd: PathSpec | str
) -> list[PathSpec]:
    """Treat positional operands as files (GNU rule when -e/-f give script).

    The arg parser routes the first bare arg into the positional ``text``
    (script) slot, so recover it as a path operand.

    Args:
        texts (list[str]): positional operands that are really files.
        cwd (PathSpec | str): current directory for relative resolution.
    """
    base = cwd.virtual if isinstance(cwd, PathSpec) else (cwd or "/")
    out: list[PathSpec] = []
    for t in texts:
        resolved = (
            posixpath.normpath(t)
            if t.startswith("/")
            else posixpath.normpath(posixpath.join(base, t))
        )
        slash = resolved.rfind("/")
        out.append(
            PathSpec(
                virtual=resolved,
                directory=resolved[: slash + 1] if slash >= 0 else "/",
                resolved=True,
                vfs_path=resolved.strip("/"),
            )
        )
    return out


async def sed_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    resolve_glob: Callable[..., Awaitable[list[PathSpec]]],
    read_stream: PolymorphicReadFn,
    writable: bool,
) -> tuple[ByteSource | None, IOResult]:
    """Run sed over the given operands, as GNU sed 4.9; mirrors
    sedGeneric.

    The script comes from -e expressions and -f script files, compiled
    in option order, when any were given, otherwise from the first
    positional operand. mirage-rs compiles and runs it; every operand and
    every file the script names is a request the host serves. The default
    stream-to-stdout path is read-only and works on every backend; only
    in-place editing needs a write op (#382).

    Args:
        paths (list[PathSpec]): The path operands, unresolved.
        texts (list[str]): Positional words (script, or files under -e/-f).
        ctx (Context): Flags, stdin and cwd from the dispatcher.
        resolve_glob (Callable[..., Awaitable[list[PathSpec]]]):
            Expands globs against the backend.
        read_stream (PolymorphicReadFn): Bound input reader.
        writable (bool): Whether the backend can write, as -i needs.
    """
    read = normalized_read(read_stream)
    parsed = parse_flags(ctx.flags)
    origins = _script_origins(ctx.argv, len(parsed.scripts))
    pieces: list[JsonValue] = []
    for index, part in enumerate(parsed.scripts):
        shown = origins[index] if origins is not None else None
        if isinstance(part, str):
            piece: dict[str, JsonValue] = {"text": byte_view(part)}
            if shown is not None:
                piece["file"] = byte_view(shown)
            pieces.append(piece)
            continue
        name = shown if shown is not None else part.raw_path
        try:
            data = await materialize(read(part))
        except FS_ERRORS as exc:
            strerror = fs_strerror(exc) or posix_phrase(FsCondition.EACCES)
            return _failed(f"sed: couldn't open file {name}: {strerror}\n", 4)
        pieces.append(
            {"text": data.decode("latin-1"), "file": byte_view(name)}
        )
    flag_script = bool(parsed.scripts)
    if not flag_script and texts:
        pieces.append({"text": byte_view(texts[0])})
    if not pieces:
        return _failed(f"{SED_MISSING_SCRIPT}\n", 1)
    if parsed.in_place and not writable:
        # A backend with no write op refuses the edit itself, not a file:
        # the line names no operand, so sed's step wording is not it.
        return _failed(
            "sed: -i not supported on this backend: Permission denied\n", 1
        )
    operands = list(paths)
    if flag_script:
        # With -e/-f the positional operand is a file, not the script.
        operands = _positional_as_paths(list(texts), ctx.cwd) + operands
    if operands:
        operands = await resolve_glob(operands)
    # -i edits `-` as a file; otherwise an operand naming stdin is `-`
    # to F and to sed's messages.
    names = [
        "-" if not parsed.in_place and is_stdin(p) else p.raw_path
        for p in operands
    ]
    config: dict[str, JsonValue] = {
        "pieces": pieces,
        "extended": parsed.extended,
        "utf8": utf8_locale(ctx.env),
        "quiet": parsed.suppress,
        "separate": parsed.separate,
        "in_place": parsed.in_place,
        "line_length": parsed.line_length,
        "inputs": [byte_view(name) for name in names],
        "paths": [byte_view(p.virtual) for p in operands],
        "cwd": byte_view(ctx.cwd.virtual),
    }
    host = StreamHost(
        operands,
        read,
        ctx.stdin,
        dispatch_of(ctx),
        ctx.cwd,
        None,
        _served_here,
        dash=not parsed.in_place,
    )
    io = IOResult()
    return _sed_stream(config, host, io), io


__all__ = ["sed_generic", "sed_writes"]
