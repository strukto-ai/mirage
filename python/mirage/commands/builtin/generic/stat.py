import re
from collections.abc import Awaitable, Callable

from mirage.commands.builtin.utils.formatting import _ls_mode_string
from mirage.commands.builtin.utils.output import format_records
from mirage.core.timeutil import iso_to_epoch
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import FS_ERRORS, fs_error_line

# GNU printf-style directive: %[flags][width][.precision]conversion, where
# conversion is a letter (optionally H/L-prefixed for device major/minor) or
# a literal %. Parsing flags/width/precision up front stops them being
# mistaken for the conversion char (e.g. %04a must not read as directive "0").
_FORMAT_RE = re.compile(r"%([#0 +-]*)(\d*)(?:\.(\d*))?([HL]?[A-Za-z%])")

_STR_DIRECTIVES = frozenset("nNF")

_TYPE_LABELS = {
    FileType.DIRECTORY: "directory",
    FileType.TEXT: "regular file",
    FileType.BINARY: "regular file",
    FileType.JSON: "regular file",
    FileType.CSV: "regular file",
}

_DEFAULT_OWNER = "user"


def _type_label(s: FileStat) -> str:
    return _TYPE_LABELS.get(s.type,
                            "regular file") if s.type else "regular file"


def _effective_mode(s: FileStat) -> int:
    if s.mode is not None:
        return s.mode & 0o7777
    return 0o755 if s.type == FileType.DIRECTORY else 0o644


def _type_bits(s: FileStat) -> int:
    return 0o040000 if s.type == FileType.DIRECTORY else 0o100000


def _owner(value: int | str | None) -> str:
    return str(value) if value is not None else _DEFAULT_OWNER


def _epoch(iso: str | None) -> str:
    if not iso:
        return "0"
    try:
        return str(iso_to_epoch(iso))
    except (ValueError, TypeError):
        return "0"


def _quote_name(name: str) -> str:
    """Shell-safe quoting for %N, mirroring GNU's default.

    A name with no apostrophe is single-quoted; one containing an
    apostrophe (but no double quote) switches to double quotes; one with
    both is single-quoted with each apostrophe escaped as ``'\\''``.

    Args:
        name (str): the file name to quote.
    """
    if "'" not in name:
        return f"'{name}'"
    if '"' not in name:
        return f'"{name}"'
    return "'" + name.replace("'", "'\\''") + "'"


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
    if spec == "N":
        return _quote_name(name)
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


def _format_stat(fmt: str, s: FileStat, name: str) -> str:
    return _FORMAT_RE.sub(
        lambda m: _apply_flags(_directive_value(m.group(4), s, name), m.group(
            1), m.group(2), m.group(3), m.group(4)), fmt)


async def stat(
    paths: list[PathSpec],
    *,
    stat_fn: Callable[..., Awaitable[FileStat]],
    c: str | None = None,
    f: str | None = None,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        raise ValueError("stat: missing operand")
    fmt = c if c is not None else f
    lines: list[str] = []
    err = b""
    for p in paths:
        try:
            s = await stat_fn(p)
        except FS_ERRORS as exc:
            # GNU stat keeps reporting the remaining operands, exit 1.
            err += fs_error_line("stat", p, exc).encode()
            continue
        if fmt is not None:
            lines.append(_format_stat(fmt, s, p.raw_path))
        else:
            lines.append(f"name={s.name} size={s.size}"
                         f" modified={s.modified}"
                         f" type={s.type.value if s.type else None}")
    io = IOResult(exit_code=1 if err else 0, stderr=err or None)
    if not lines:
        return None, io
    return format_records(lines), io


__all__ = ["stat"]
