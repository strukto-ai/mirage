from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from itertools import groupby

from mirage.commands.builtin.utils.formatting import _ls_mode_string
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagValue, FlagView
from mirage.core.timeutil import iso_to_epoch
from mirage.io.types import ByteSource, IOResult
from mirage.ops.types import LinkView
from mirage.types import LINK_TARGET_KEY, FileStat, FileType, PathSpec
from mirage.utils.errors import FS_ERRORS, fs_error_line

_STR_DIRECTIVES = frozenset("nNF")

_FORMAT_FLAGS = frozenset("#0 +-")

_ASCII_DIGITS = frozenset("0123456789")

_TYPE_LABELS = {
    FileType.DIRECTORY: "directory",
    FileType.SYMLINK: "symbolic link",
    FileType.TEXT: "regular file",
    FileType.BINARY: "regular file",
    FileType.JSON: "regular file",
    FileType.CSV: "regular file",
}

_DEFAULT_OWNER = "user"

_SHELL_SPECIAL = frozenset("!\"#$&()*;<=>?[\\^`{|}~")

_START_SAFE = frozenset("#~")

_ESCAPE_NAMES = {
    "\a": "\\a",
    "\b": "\\b",
    "\t": "\\t",
    "\n": "\\n",
    "\v": "\\v",
    "\f": "\\f",
    "\r": "\\r",
}


@dataclass(frozen=True, slots=True)
class _FormatDirective:
    """One parsed ``%[flags][width][.precision]conversion`` directive.

    Args:
        end (int): index just past the directive in the format string.
        flags (str): any of ``# 0 + -``.
        width (str): minimum field width (digits) or empty.
        precision (str | None): precision digits, or None when absent.
        spec (str): the conversion char, H/L-prefixed for device major/minor.
    """

    end: int
    flags: str
    width: str
    precision: str | None
    spec: str


def _type_label(s: FileStat) -> str:
    return _TYPE_LABELS.get(s.type,
                            "regular file") if s.type else "regular file"


def _effective_mode(s: FileStat) -> int:
    if s.mode is not None:
        return s.mode & 0o7777
    if s.type == FileType.DIRECTORY:
        return 0o755
    # A symlink carries no permission bits of its own; GNU reports 0777.
    if s.type == FileType.SYMLINK:
        return 0o777
    return 0o644


def _type_bits(s: FileStat) -> int:
    if s.type == FileType.DIRECTORY:
        return 0o040000
    if s.type == FileType.SYMLINK:
        return 0o120000
    return 0o100000


def _owner(value: int | str | None) -> str:
    return str(value) if value is not None else _DEFAULT_OWNER


def _epoch(iso: str | None) -> str:
    if not iso:
        return "0"
    try:
        return str(iso_to_epoch(iso))
    except (ValueError, TypeError):
        return "0"


def _needs_escape(char: str) -> bool:
    """Whether GNU spells a character as a ``$'..'`` escape.

    Args:
        char (str): the character to test.
    """
    return char < " " or char == "\x7f"


def _escape_char(char: str) -> str:
    """Spell one character the way bash's ``$'..'`` does.

    Args:
        char (str): the character to escape.
    """
    named = _ESCAPE_NAMES.get(char)
    return named if named is not None else f"\\{ord(char):03o}"


def _double_quotable(name: str) -> bool:
    """Whether a name holding an apostrophe still fits in double quotes.

    GNU only reaches for them when nothing else in the name would stay
    live inside them, so ``a'b`` renders as ``"a'b"`` but ``a'b$c`` does
    not. ``#`` and ``~`` count as special only away from the front.

    Args:
        name (str): the name to test.
    """
    for index, char in enumerate(name):
        if _needs_escape(char):
            return False
        if char in _SHELL_SPECIAL and not (index == 0 and char in _START_SAFE):
            return False
    return True


def _single_quoted(name: str) -> str:
    """Render single-quoted runs spliced with ``$'..'`` escape segments.

    Args:
        name (str): the name to quote.
    """
    parts: list[str] = []
    for index, (escaped, chars) in enumerate(groupby(name, _needs_escape)):
        run = "".join(chars)
        if not escaped:
            parts.append("'" + run.replace("'", "'\\''") + "'")
            continue
        # A leading escape keeps the empty quotes GNU emits; a trailing
        # one does not.
        if index == 0:
            parts.append("''")
        parts.append("$'" + "".join(_escape_char(c) for c in run) + "'")
    return "".join(parts) if parts else "''"


def _quote_name(name: str) -> str:
    """Shell-safe quoting for %N, mirroring GNU's default.

    Single quotes are the rule, with each apostrophe escaped as
    ``'\\''`` and every unprintable character lifted into a ``$'..'``
    segment. A name whose only awkward character is an apostrophe reads
    better in double quotes, and GNU renders that one case that way.

    Args:
        name (str): the file name to quote.
    """
    if "'" in name and _double_quotable(name):
        return f'"{name}"'
    return _single_quoted(name)


def _apply_flags(value: str, flags: str, width: str, precision: str | None,
                 spec: str) -> str:
    """Apply GNU printf flags/width/precision to a rendered directive.

    Args:
        value (str): the raw directive value.
        flags (str): any of ``# 0 + -``.
        width (str): minimum field width (digits) or empty.
        precision (str | None): precision digits, or None when absent.
        spec (str): the conversion character.
    """
    if "#" in flags and spec == "a" and not value.startswith("0"):
        value = "0" + value
    if precision is not None and spec in _STR_DIRECTIVES:
        value = value[:int(precision)] if precision else ""
    if width and len(value) < int(width):
        w = int(width)
        if "-" in flags:
            value = value.ljust(w)
        elif "0" in flags:
            value = value.rjust(w, "0")
        else:
            value = value.rjust(w)
    return value


def _directive_value(spec: str, s: FileStat, name: str) -> str:
    if spec == "%":
        return "%"
    if spec == "n":
        return name
    if spec == "s":
        return str(s.size if s.size is not None else 0)
    if spec == "F":
        return _type_label(s)
    if spec == "a":
        return format(_effective_mode(s), "o")
    if spec == "A":
        return _ls_mode_string(s)
    if spec == "f":
        return format(_type_bits(s) | _effective_mode(s), "x")
    if spec in ("u", "U"):
        return _owner(s.uid)
    if spec in ("g", "G"):
        return _owner(s.gid)
    if spec == "x":
        return s.atime or s.modified or ""
    if spec == "X":
        return _epoch(s.atime or s.modified)
    if spec in ("y", "z"):
        return s.modified or ""
    if spec in ("Y", "Z"):
        return _epoch(s.modified)
    if spec == "w":
        return "-"
    if spec == "W":
        return "0"
    if spec == "B":
        return "512"
    if spec in ("r", "R", "t", "T"):
        return "0"
    if len(spec) == 2 and spec[0] in "HL":
        # %Hr/%Lr are rdev major/minor (0, like %r); %Hd/%Ld are device
        # major/minor, which a VFS has no truthful value for.
        return "0" if spec[1] in "rR" else "?"
    return "?"


def _name_parts(s: FileStat, name: str, quoted: bool) -> list[str]:
    """The fields ``%N`` renders: the name, plus a symlink's target.

    Args:
        s (FileStat): the stat being rendered.
        name (str): the operand as it was typed.
        quoted (bool): shell-quote each field. GNU only does so for a bare
            ``%N``; any flag, width or precision drops the quotes.
    """
    parts = [name]
    if s.type == FileType.SYMLINK:
        target = s.extra.get(LINK_TARGET_KEY)
        if target:
            parts.append(str(target))
    return [_quote_name(p) for p in parts] if quoted else parts


def _render_directive(d: _FormatDirective, s: FileStat, name: str) -> str:
    """Render one directive with its flags, width and precision applied.

    Args:
        d (_FormatDirective): the parsed directive.
        s (FileStat): the stat being rendered.
        name (str): the operand as it was typed.
    """
    if d.spec == "N":
        # GNU formats the name and a symlink's target as two separate
        # fields, so a width pads each one rather than the joined line.
        bare = not d.flags and not d.width and d.precision is None
        return " -> ".join(
            _apply_flags(part, d.flags, d.width, d.precision, d.spec)
            for part in _name_parts(s, name, bare))
    return _apply_flags(_directive_value(d.spec, s, name), d.flags, d.width,
                        d.precision, d.spec)


def _is_conversion(char: str) -> bool:
    return char == "%" or "A" <= char <= "Z" or "a" <= char <= "z"


def _parse_format_directive(fmt: str, start: int) -> _FormatDirective | None:
    """Scan one GNU printf-style directive starting at a ``%``.

    Walks flags, width and precision with an explicit cursor so a long run
    of flag/width characters that never reaches a conversion char costs
    linear time instead of backtracking (CodeQL #247).

    Args:
        fmt (str): the whole format string.
        start (int): index of the leading ``%``.
    """
    end = len(fmt)
    cursor = start + 1
    flags_start = cursor
    while cursor < end and fmt[cursor] in _FORMAT_FLAGS:
        cursor += 1
    flags = fmt[flags_start:cursor]

    width_start = cursor
    while cursor < end and fmt[cursor] in _ASCII_DIGITS:
        cursor += 1
    width = fmt[width_start:cursor]

    precision: str | None = None
    if cursor < end and fmt[cursor] == ".":
        cursor += 1
        precision_start = cursor
        while cursor < end and fmt[cursor] in _ASCII_DIGITS:
            cursor += 1
        precision = fmt[precision_start:cursor]

    if cursor >= end or not _is_conversion(fmt[cursor]):
        return None
    spec = fmt[cursor]
    cursor += 1
    if spec in ("H", "L") and cursor < end and _is_conversion(fmt[cursor]):
        spec += fmt[cursor]
        cursor += 1
    return _FormatDirective(end=cursor,
                            flags=flags,
                            width=width,
                            precision=precision,
                            spec=spec)


def _format_stat(fmt: str, s: FileStat, name: str) -> str:
    parts: list[str] = []
    cursor = 0
    while cursor < len(fmt):
        start = fmt.find("%", cursor)
        if start == -1:
            parts.append(fmt[cursor:])
            break
        parts.append(fmt[cursor:start])
        directive = _parse_format_directive(fmt, start)
        if directive is None:
            parts.append("%")
            cursor = start + 1
            continue
        parts.append(_render_directive(directive, s, name))
        cursor = directive.end
    return "".join(parts)


def _render_stat(s: FileStat) -> str:
    """Render the default (no -c) stat line.

    Args:
        s (FileStat): the stat to render.
    """
    return (f"name={s.name} size={s.size} modified={s.modified}"
            f" type={s.type.value if s.type else None}")


async def stat(
    paths: list[PathSpec],
    *,
    stat_fn: Callable[..., Awaitable[FileStat]],
    c: str | None = None,
    f: str | None = None,
    L: bool = False,
    links: LinkView | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Report file status, GNU stat semantics.

    Args:
        paths (list[PathSpec]): operands to stat.
        stat_fn (Callable): backend stat for a resolved path.
        c (str | None): output format string.
        f (str | None): output format string (alias of -c here).
        L (bool): dereference symlinks instead of reporting the link.
        links (LinkView | None): the namespace's symlink facts;
            absent when the workspace holds no links.
    """
    if not paths:
        raise ValueError("stat: missing operand")
    fmt = c if c is not None else f
    lines: list[str] = []
    err = b""
    for p in paths:
        # GNU stat lstats: a symlink operand reports the link itself,
        # not its target, unless -L asks to dereference. A link has no
        # backend inode, so the namespace is the only authority for it.
        linked = None if L or links is None else links.stat_at(p.virtual)
        if linked is not None:
            if fmt is not None:
                lines.append(_format_stat(fmt, linked, p.raw_path))
            else:
                lines.append(_render_stat(linked))
            continue
        try:
            s = await stat_fn(p)
        except FS_ERRORS as exc:
            # GNU stat keeps reporting the remaining operands, exit 1.
            err += fs_error_line("stat", p, exc).encode()
            continue
        if fmt is not None:
            lines.append(_format_stat(fmt, s, p.raw_path))
        else:
            lines.append(_render_stat(s))
    io = IOResult(exit_code=1 if err else 0, stderr=err or None)
    if not lines:
        return None, io
    return format_records(lines), io


__all__ = ["stat"]


@dataclass(frozen=True, slots=True)
class StatFlags:
    format: str | None = None
    file_system: str | None = None
    deref: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> StatFlags:
    fl = FlagView(flags, spec=SPECS["stat"])
    return StatFlags(
        format=fl.as_str("c"),
        file_system=fl.as_str("f"),
        deref=fl.as_bool("L"),
    )


async def stat_generic(paths, texts, opts: CommandOpts, stat_fn):
    parsed = parse_flags(opts.flags)
    return await stat(paths,
                      stat_fn=stat_fn,
                      c=parsed.format,
                      f=parsed.file_system,
                      L=parsed.deref,
                      links=opts.ns.links if opts.ns is not None else None)
