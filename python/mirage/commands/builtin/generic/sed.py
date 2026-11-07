import json
import posixpath
from collections.abc import (
    Awaitable,
    Callable,
    Mapping,
    Sequence,
)
from dataclasses import dataclass

from mirage.commands.builtin.utils.links import (
    dispatch_of,
    links_of,
    mounts_of,
)
from mirage.commands.builtin.utils.operands import normalized_read
from mirage.commands.builtin.utils.stream import is_stdin
from mirage.commands.builtin.utils.stream_host import (
    StreamHost,
    hosted_stream,
)
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.compile import compile_spec, expand_long
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.commands.spec.usage import usage_hint
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import fs_strerror
from mirage.errors.posix import posix_phrase
from mirage.errors.types import FsCondition
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.rs.stream import open_stream
from mirage.shell.bytes import byte_view, encode_text, utf8_locale
from mirage.types import JsonValue, LineFacts, PathSpec, PolymorphicReadFn


def _failed(stderr: str, exit_code: int) -> tuple[None, IOResult]:
    return None, IOResult(exit_code=exit_code, stderr=encode_text(stderr))


@dataclass(frozen=True, slots=True)
class SedFlags:
    in_place: bool = False
    # -i's SUFFIX, none when it keeps no backup.
    suffix: str | None = None
    suppress: bool = False
    extended: bool = False
    separate: bool = False
    line_length: str | None = None
    scripts: tuple[str | PathSpec, ...] = ()
    null_data: bool = False
    unbuffered: bool = False
    posix: bool = False
    sandbox: bool = False
    debug: bool = False
    follow_symlinks: bool = False


def edits_in_place(fl: FlagView) -> bool:
    """Whether the line edits in place: -i given, with a suffix or none
    (``--in-place=``).

    Args:
        fl (FlagView): the line's flags.
    """
    return fl.raw("in_place") not in (None, False)


def parse_flags(flags: Mapping[str, FlagValue]) -> SedFlags:
    fl = FlagView(flags, spec=SPECS["sed"])
    expressions = iter(fl.as_list("expression"))
    files = iter(fl.as_paths("file"))
    in_place = fl.raw("in_place")
    return SedFlags(
        in_place=edits_in_place(fl),
        suffix=in_place if isinstance(in_place, str) and in_place else None,
        suppress=fl.as_bool("quiet"),
        extended=fl.as_bool("regexp_extended"),
        separate=fl.as_bool("separate"),
        line_length=fl.as_text("line_length"),
        scripts=tuple(
            next(expressions) if name == "expression" else next(files)
            for name, _ in fl.occurrences("expression", "file")
        ),
        null_data=fl.as_bool("null_data"),
        unbuffered=fl.as_bool("unbuffered"),
        posix=fl.as_bool("posix"),
        sandbox=fl.as_bool("sandbox"),
        debug=fl.as_bool("debug"),
        follow_symlinks=fl.as_bool("follow_symlinks"),
    )


def facts(fl: FlagView, operands: Sequence[str | PathSpec]) -> LineFacts:
    """A sed line may change files under ``-i``, with a script file (its
    text is read only when sed runs), or when its script names a ``w``
    file, which GNU opens even when it then refuses the script.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
        operands (Sequence[str | PathSpec]): the line's operands; the
            first is the script when no ``-e`` or ``-f`` gave one.
    """
    if edits_in_place(fl) or fl.raw("file") is not None:
        return LineFacts()
    scripts = fl.as_list("expression") or [
        w if isinstance(w, str) else w.raw_path for w in operands[:1]
    ]
    if not scripts:
        return LineFacts(writes=False)
    syntax = (
        fl.as_bool("regexp_extended"),
        fl.as_bool("posix"),
        fl.as_bool("sandbox"),
    )
    return LineFacts(writes=_script_writes(tuple(scripts), syntax))


_write_checks: dict[tuple[tuple[str, ...], tuple[bool, bool, bool]], bool] = {}


def _script_writes(
    scripts: tuple[str, ...], syntax: tuple[bool, bool, bool]
) -> bool:
    cacheable = sum(len(script) + 1 for script in scripts) <= 4096
    key = (scripts, syntax)
    if cacheable and (known := _write_checks.get(key)) is not None:
        del _write_checks[key]
        _write_checks[key] = known
        return known
    extended, posix, sandbox = syntax
    engine = open_stream(
        "sed",
        {
            "pieces": [{"text": byte_view(script)} for script in scripts],
            "extended": extended,
            "posix": posix,
            "sandbox": sandbox,
        },
    )
    writes = bool(json.loads(engine.metadata())["writes"])
    if cacheable:
        if len(_write_checks) >= 64:
            del _write_checks[next(iter(_write_checks))]
        _write_checks[key] = writes
    return writes


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
            name, eq, value = word.partition("=")
            spelled = expand_long(compile_spec(SPECS["sed"]), name)
            option = spelled[0] if len(spelled) == 1 else name
            if option in _VALUED and not eq:
                value = argv[i] if i < len(argv) else ""
                i += 1
            out.extend(_origin(option, value))
            continue
        if not word.startswith("-") or word == "-":
            continue
        for j in range(1, len(word)):
            c = word[j]
            # -i takes the rest of the word as its suffix.
            if c == "i":
                break
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


# The long options that take their value as the next word.
_VALUED = frozenset({"--expression", "--file", "--line-length"})


def _origin(option: str, value: str) -> list[str | None]:
    """What one long option adds to ``_script_origins``: a script file's
    name, None for an expression, nothing for any other option.

    Args:
        option (str): the long option, its prefix expanded.
        value (str): its value.
    """
    if option == "--file":
        return [value]
    if option == "--expression":
        return [None]
    return []


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
        return _failed(f"{usage_hint('sed')}\n", 1)
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
        "suffix": (
            None if parsed.suffix is None else byte_view(parsed.suffix)
        ),
        "posix": parsed.posix,
        "sandbox": parsed.sandbox,
        "null_data": parsed.null_data,
        "follow_symlinks": parsed.follow_symlinks,
        "debug": parsed.debug,
        "line_length": (
            None
            if parsed.line_length is None
            else byte_view(parsed.line_length)
        ),
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
        dash=not parsed.in_place,
        links=links_of(ctx),
        mounts=mounts_of(ctx),
        unbuffered=parsed.unbuffered,
    )
    io = IOResult()
    return hosted_stream("sed", config, host, io), io


__all__ = ["facts", "sed_generic"]
