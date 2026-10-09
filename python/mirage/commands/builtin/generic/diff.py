import difflib
import re
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone, tzinfo

from mirage.commands.builtin.diff_format import ed_script, normal_diff
from mirage.commands.builtin.utils.formatting import full_iso_time
from mirage.commands.builtin.utils.lines import split_lines_keepends
from mirage.commands.builtin.utils.stream import (
    is_stdin,
    stdin_bytes,
    stdin_stat,
)
from mirage.commands.config import CommandOpts
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.compile import compile_spec
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import Argument, CommandName, FlagValue
from mirage.commands.spec.usage import (
    extra_operand_error,
    missing_operand_error,
)
from mirage.errors.constants import FS_ERRORS
from mirage.errors.render import format_fs_error
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.fnmatch import fnmatch
from mirage.utils.key_prefix import rekey
from mirage.utils.path import gnu_basename
from mirage.utils.quote import shell_quote
from mirage.utils.timezone import zone_from_env
from mirage.view.types import StatPath


@dataclass(frozen=True, slots=True)
class DiffFlags:
    ignore_case: bool = False
    ignore_all_space: bool = False
    ignore_space_change: bool = False
    ed: bool = False
    unified: bool = False
    context: int = 3
    brief: bool = False
    recursive: bool = False
    # -N reads a file missing on either side as empty, and
    # --unidirectional-new-file only one missing from the first.
    new_file: bool = False
    new_first: bool = False
    identical: bool = False
    exclude: tuple[str, ...] = ()
    exclude_from: tuple[PathSpec, ...] = ()


@dataclass(frozen=True, slots=True)
class _Walk:
    read_bytes: Callable[..., Awaitable[bytes]]
    readdir_fn: Callable[..., Awaitable[list[str]]]
    stat_fn: Callable[..., Awaitable[FileStat]]
    flags: DiffFlags
    excluded: tuple[str, ...]
    switches: str
    stat_path: StatPath | None = None
    zone: tzinfo | None = None


Absent = tuple[bool, bool]

PRESENT: Absent = (False, False)

# diffutils' c_escape_char: the characters a header name spells as a C
# escape. Any other control character is three octal digits.
C_ESCAPES = {
    "\a": "a",
    "\b": "b",
    "\t": "t",
    "\n": "n",
    "\v": "v",
    "\f": "f",
    "\r": "r",
    '"': '"',
    "\\": "\\",
}


def _child_spec(parent: PathSpec, name: str) -> PathSpec:
    child = parent.virtual.rstrip("/") + "/" + name
    return PathSpec(
        virtual=child,
        directory=child,
        vfs_path=rekey(parent.virtual, parent.vfs_path, child),
        raw_path=_name(parent).rstrip("/") + "/" + name,
    )


def _name(path: PathSpec) -> str:
    return path.raw_path or path.virtual


def c_escape(name: str) -> str:
    """A file name as GNU diff writes it in a header line.

    diffutils' ``c_escape`` double-quotes a name holding a space, a
    double quote, a backslash or a control character, and writes each of
    those but the space as a C escape (``"sp ace"``, ``"t\\tab"``); any
    other name, bytes above ASCII included, is written as it is. The
    ``---`` and ``+++`` lines and the ``diff -r`` line use it; the
    ``Only in`` and ``Files ... differ`` lines do not.

    Args:
        name (str): the name as typed or walked.
    """
    if not any(ch == " " or ch in C_ESCAPES or ch < " " for ch in name):
        return name
    out: list[str] = []
    for ch in name:
        if ch in C_ESCAPES:
            out.append("\\" + C_ESCAPES[ch])
        elif ch < " ":
            out.append(f"\\{ord(ch):03o}")
        else:
            out.append(ch)
    return '"' + "".join(out) + '"'


async def _header_time(walk: _Walk, path: PathSpec, absent: bool) -> str:
    """The time a unified header gives one side, as GNU diff prints it.

    The modification time as ``%Y-%m-%d %H:%M:%S.%N %z`` in the zone
    ``TZ`` names, read through the dispatcher as ``stat`` reads it, so
    a time ``touch`` keeps in the namespace shows; the epoch for a side
    -N reads as absent; and the present moment for standard input, as
    POSIX asks and diffutils does.

    Args:
        walk (_Walk): the reads and the parsed line.
        path (PathSpec): the side.
        absent (bool): whether -N reads it as absent.
    """
    if absent:
        return full_iso_time(None, walk.zone)
    if is_stdin(path):
        now = datetime.now(timezone.utc).isoformat()
        return full_iso_time(now, walk.zone)
    info = await walk.stat_path(path) if walk.stat_path is not None else None
    if info is None:
        info = await walk.stat_fn(path)
    return full_iso_time(info.modified, walk.zone)


def _takes_value(option: Argument) -> bool:
    return (
        option.action not in ("store_true", "count")
        and not option.nargs == "?"
    )


def switch_words(argv: Sequence[str]) -> list[str]:
    """The option words of a diff line, as GNU echoes them.

    GNU diff permutes its options in front of its operands and prints
    them, word for word and in order, on each ``diff -r`` header line:
    an option's detached value is its own word, ``--`` is kept, and
    every operand is left out.

    Args:
        argv (Sequence[str]): the words after ``diff``.
    """
    options = compile_spec(SPECS[CommandName.DIFF]).options
    shorts = {
        name[1:]: o
        for o in options
        for name in o.names
        if not name.startswith("--")
    }
    longs = {
        name[2:]: o
        for o in options
        for name in o.names
        if name.startswith("--")
    }
    words: list[str] = []
    i = 0
    while i < len(argv):
        word = argv[i]
        i += 1
        if word == "--":
            words.append(word)
            break
        if not word.startswith("-") or word == "-":
            continue
        words.append(word)
        if word.startswith("--"):
            name = word[2:].partition("=")[0]
            found = longs.get(name)
            matches = (
                [found]
                if found is not None
                else [o for n, o in longs.items() if n.startswith(name)]
            )
            if (
                "=" not in word
                and len(matches) == 1
                and _takes_value(matches[0])
                and i < len(argv)
            ):
                words.append(argv[i])
                i += 1
            continue
        for at, letter in enumerate(word[1:], 1):
            option = shorts.get(letter)
            if option is not None and _takes_value(option):
                if at == len(word) - 1 and i < len(argv):
                    words.append(argv[i])
                    i += 1
                break
    return words


async def _side(walk: _Walk, path: PathSpec, absent: bool) -> str:
    if absent:
        return ""
    return (await walk.read_bytes(path)).decode(errors="replace")


async def _diff_pair(
    path1: PathSpec,
    path2: PathSpec,
    walk: _Walk,
    absent: Absent = PRESENT,
) -> bytes:
    flags = walk.flags
    name1 = _name(path1)
    name2 = _name(path2)
    text_a = await _side(walk, path1, absent[0])
    text_b = await _side(walk, path2, absent[1])
    if flags.ignore_case:
        text_a = text_a.lower()
        text_b = text_b.lower()
    if flags.ignore_all_space:
        text_a = re.sub(r"\s+", "", text_a)
        text_b = re.sub(r"\s+", "", text_b)
    if flags.ignore_space_change:
        text_a = re.sub(r"[ \t]+", " ", text_a)
        text_b = re.sub(r"[ \t]+", " ", text_b)
    if text_a == text_b:
        if flags.identical:
            return f"Files {name1} and {name2} are identical\n".encode()
        return b""
    if flags.brief:
        return f"Files {name1} and {name2} differ\n".encode()
    a_lines = split_lines_keepends(text_a)
    b_lines = split_lines_keepends(text_b)
    if flags.ed:
        result = ed_script(a_lines, b_lines)
    elif flags.unified:
        result = list(
            difflib.unified_diff(
                a_lines,
                b_lines,
                fromfile=c_escape(name1),
                tofile=c_escape(name2),
                fromfiledate=await _header_time(walk, path1, absent[0]),
                tofiledate=await _header_time(walk, path2, absent[1]),
                n=flags.context,
            )
        )
    else:
        result = normal_diff(a_lines, b_lines)
    return "".join(result).encode()


def _is_identical(body: bytes) -> bool:
    return body.endswith(b" are identical\n")


async def _entries(walk: _Walk, path: PathSpec, absent: bool) -> set[str]:
    if absent:
        return set()
    names = {gnu_basename(entry) for entry in await walk.readdir_fn(path)}
    return {
        name
        for name in names
        if not any(fnmatch(name, pattern) for pattern in walk.excluded)
    }


async def _diff_dirs(
    dir_a: PathSpec,
    dir_b: PathSpec,
    walk: _Walk,
    absent: Absent = PRESENT,
) -> tuple[bytes, bool]:
    """Compare two directories, one of which -N may read as empty.

    Args:
        dir_a (PathSpec): the first directory.
        dir_b (PathSpec): the second directory.
        walk (_Walk): the reads and the parsed line.
        absent (Absent): which side is missing.

    Returns:
        tuple[bytes, bool]: the report and whether any pair differed.
    """
    flags = walk.flags
    names_a = await _entries(walk, dir_a, absent[0])
    names_b = await _entries(walk, dir_b, absent[1])
    left = _name(dir_a).rstrip("/")
    right = _name(dir_b).rstrip("/")
    parts: list[bytes] = []
    differ = False
    for name in sorted(names_a | names_b):
        in_a = name in names_a
        in_b = name in names_b
        if not in_b and not flags.new_file:
            parts.append(f"Only in {left}: {name}\n".encode())
            differ = True
            continue
        if not in_a and not flags.new_first:
            parts.append(f"Only in {right}: {name}\n".encode())
            differ = True
            continue
        child_a = _child_spec(dir_a, name)
        child_b = _child_spec(dir_b, name)
        a_dir = (
            in_a and (await walk.stat_fn(child_a)).type == FileType.DIRECTORY
        )
        b_dir = (
            in_b and (await walk.stat_fn(child_b)).type == FileType.DIRECTORY
        )
        gone = (not in_a, not in_b)
        if (a_dir or not in_a) and (b_dir or not in_b):
            body, changed = await _diff_dirs(child_a, child_b, walk, gone)
            parts.append(body)
            differ = differ or changed
        elif not a_dir and not b_dir:
            body = await _diff_pair(child_a, child_b, walk, gone)
            if not body or _is_identical(body):
                parts.append(body)
                continue
            differ = True
            if flags.brief:
                parts.append(body)
            else:
                header = (
                    f"diff{walk.switches} {c_escape(_name(child_a))} "
                    f"{c_escape(_name(child_b))}\n"
                )
                parts.append(header.encode() + body)
        elif a_dir:
            differ = True
            parts.append(
                (
                    f"File {_name(child_a)} is a directory while file "
                    f"{_name(child_b)} is a regular file\n"
                ).encode()
            )
        else:
            differ = True
            parts.append(
                (
                    f"File {_name(child_a)} is a regular file while file "
                    f"{_name(child_b)} is a directory\n"
                ).encode()
            )
    return b"".join(parts), differ


async def _missing(
    stat_fn: Callable[..., Awaitable[FileStat]], path: PathSpec, allowed: bool
) -> bool:
    if not allowed or is_stdin(path):
        return False
    try:
        await stat_fn(path)
    except FileNotFoundError:
        return True
    return False


async def _excluded_patterns(
    flags: DiffFlags, read_bytes: Callable[..., Awaitable[bytes]]
) -> tuple[str, ...]:
    patterns = list(flags.exclude)
    for path in flags.exclude_from:
        text = (await read_bytes(path)).decode(errors="replace")
        patterns.extend(line for line in text.split("\n") if line)
    return tuple(patterns)


async def diff(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    readdir_fn: Callable[..., Awaitable[list[str]]],
    stat_fn: Callable[..., Awaitable[FileStat]],
    flags: DiffFlags,
    stdin: ByteSource | None = None,
    argv: Sequence[str] = (),
    stat_path: StatPath | None = None,
    zone: tzinfo | None = None,
) -> tuple[ByteSource | None, IOResult]:
    if len(paths) > 2:
        raise extra_operand_error(CommandName.DIFF, paths[2].raw_path)
    if len(paths) < 2:
        raise missing_operand_error(
            CommandName.DIFF, _name(paths[-1]) if paths else None, argv
        )
    if is_stdin(paths[0]) and is_stdin(paths[1]):
        # Both name the one stdin, which GNU sees as the same file.
        return None, IOResult()
    read_bytes = stdin_bytes(read_bytes, stdin)
    stat_fn = stdin_stat(stat_fn)
    dashes = [p.raw_path == "-" for p in paths]
    try:
        walk = _Walk(
            read_bytes=read_bytes,
            readdir_fn=readdir_fn,
            stat_fn=stat_fn,
            flags=flags,
            excluded=await _excluded_patterns(flags, read_bytes),
            switches="".join(f" {shell_quote(w)}" for w in switch_words(argv)),
            stat_path=stat_path,
            zone=zone,
        )
        if any(dashes) and not all(dashes):
            other = paths[1] if dashes[0] else paths[0]
            if (await stat_fn(other)).type == FileType.DIRECTORY:
                return None, IOResult(
                    exit_code=2,
                    stderr=b"diff: cannot compare '-' to a directory\n",
                )
        # A missing operand -N reads as empty only beside one that is
        # there: two missing ones are both reported.
        absent = (
            await _missing(stat_fn, paths[0], flags.new_first),
            await _missing(stat_fn, paths[1], flags.new_file),
        )
        if all(absent):
            missing: list[bytes] = []
            for path in paths:
                try:
                    await stat_fn(path)
                except FS_ERRORS as exc:
                    missing.append(format_fs_error("diff", exc, [path]))
            return None, IOResult(exit_code=2, stderr=b"".join(missing))
        both_dirs = False
        if flags.recursive and not any(absent):
            both_dirs = (
                await stat_fn(paths[0])
            ).type == FileType.DIRECTORY and (
                await stat_fn(paths[1])
            ).type == FileType.DIRECTORY
        if both_dirs:
            output, differ = await _diff_dirs(paths[0], paths[1], walk)
        else:
            output = await _diff_pair(paths[0], paths[1], walk, absent)
            differ = bool(output) and not _is_identical(output)
    except FS_ERRORS as exc:
        # GNU diff reserves exit 1 for "files differ"; trouble (a missing
        # or unreadable operand) is exit 2.
        return None, IOResult(
            exit_code=2,
            stderr=format_fs_error("diff", exc, [*paths, *flags.exclude_from]),
        )
    return output, IOResult(exit_code=1 if differ else 0)


__all__ = ["diff"]


def parse_flags(flags: Mapping[str, FlagValue]) -> DiffFlags:
    fl = FlagView(flags, spec=SPECS["diff"])
    context = -1
    unified = fl.as_bool("u")
    for _, value in fl.occurrences("U", "unified"):
        unified = True
        if value is True:
            context = max(context, 3)
        elif (
            isinstance(value, str)
            and (
                value == ""
                or re.fullmatch(r"[ \t\n\r\v\f]*[+-]?[0-9]+", value)
            )
            and int(value or "0") >= 0
        ):
            context = max(context, min(int(value or "0"), 2**63 - 1))
        else:
            raise UsageError(
                f"diff: invalid context length '{value}'\n"
                "diff: Try 'diff --help' for more information."
            )
    new_file = fl.as_bool("new_file")
    return DiffFlags(
        ignore_case=fl.as_bool("i"),
        ignore_all_space=fl.as_bool("w"),
        ignore_space_change=fl.as_bool("b"),
        ed=fl.as_bool("e"),
        unified=unified,
        context=3 if context == -1 else context,
        brief=fl.as_bool("brief"),
        recursive=fl.as_bool("recursive"),
        new_file=new_file,
        new_first=new_file or fl.as_bool("unidirectional_new_file"),
        identical=fl.as_bool("report_identical_files"),
        exclude=tuple(fl.as_list("exclude")),
        exclude_from=tuple(fl.as_paths("exclude_from")),
    )


async def diff_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    read_bytes: Callable[..., Awaitable[bytes]],
    readdir_fn: Callable[..., Awaitable[list[str]]],
    stat_fn: Callable[..., Awaitable[FileStat]],
) -> tuple[ByteSource | None, IOResult]:
    return await diff(
        paths,
        read_bytes=read_bytes,
        readdir_fn=readdir_fn,
        stat_fn=stat_fn,
        flags=parse_flags(opts.flags),
        stdin=opts.stdin,
        argv=opts.argv,
        stat_path=opts.stat_path,
        zone=zone_from_env(opts.env),
    )
