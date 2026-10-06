from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from functools import partial
from itertools import groupby
from typing import cast

from mirage.commands.builtin.utils.formatting import (
    full_iso_time,
    ls_mode_string,
)
from mirage.commands.builtin.utils.identity import (
    Identity,
    group_name,
    identity_of,
    owner_name,
)
from mirage.commands.builtin.utils.operands import operand_stat
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.commands.spec.usage import missing_operand_error
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import fs_strerror
from mirage.errors.render import fs_error_line
from mirage.io.types import ByteSource, IOResult
from mirage.ops.types import LinkView, MountView, StatPath
from mirage.runtime.types import DispatchFn
from mirage.shell.bytes import encode_text
from mirage.types import (
    DEVICE_NUMBERS_KEY,
    LINK_TARGET_KEY,
    CapacityResult,
    CapacityState,
    FileStat,
    FileType,
    PathSpec,
    StatFn,
)
from mirage.utils.dates import iso_timestamp, iso_to_epoch
from mirage.utils.quote import shell_quote_always
from mirage.utils.stat_view import (
    content_size,
    device_rdev,
    is_dir,
    posix_mode,
)

_STR_DIRECTIVES = frozenset("nNF")

# The directives GNU knows (coreutils 9.7). It prints any other as a bare
# '?', which no width pads; one it knows that a VFS cannot answer is
# padded like the value it stands for.
_KNOWN = frozenset("aAbBCdDfFgGhimnNorRstTuUwWxXyYzZ%") | {
    "Hd",
    "Ld",
    "Hr",
    "Lr",
}

# The placeholders for a value that is not known, which a 0 flag pads
# with spaces rather than zeros.
_PLACEHOLDERS = frozenset({"-", "?"})

_FORMAT_FLAGS = frozenset("'-+ #0I")

# The conversions %H and %L split into a device's major and minor; in
# file-system mode they are no prefix at all.
_DEVICE_HALVES = "dr"

# GNU's file-system report (coreutils 9.7 stat -f), in its directives.
_FS_LAYOUT = (
    '  File: "%n"\n'
    "    ID: %-8i Namelen: %-7l Type: %T\n"
    "Block size: %-10s Fundamental block size: %S\n"
    "Blocks: Total: %-10b Free: %-10f Available: %a\n"
    "Inodes: Total: %-10c Free: %d"
)

# A mount reports its capacity in bytes; -f counts it in 1K blocks, the
# unit df reports in.
_FS_BLOCK = 1024

_FS_STRINGS = frozenset("nT")

_FS_KNOWN = frozenset("abcdfilnsStT%")

_FS_COUNTS = frozenset("abcdf")

_FS_STDIN = (
    "using '-' to denote standard input does not work in file system mode"
)

# What -f reports outside a workspace: nothing is known about the file
# system that holds a path.
_NO_FILE_SYSTEM = ("-", CapacityResult(state=CapacityState.UNKNOWN))

StatfsFn = Callable[[PathSpec], Awaitable[tuple[str, CapacityResult]]]

_ASCII_DIGITS = frozenset("0123456789")

_TYPE_LABELS = {
    FileType.DIRECTORY: "directory",
    FileType.SYMLINK: "symbolic link",
    FileType.CHAR_DEVICE: "character special file",
    FileType.FILE: "regular file",
}

_SHELL_SPECIAL = frozenset('!"#$&()*;<=>?[\\^`{|}~')

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
    return (
        _TYPE_LABELS.get(s.type, "regular file") if s.type else "regular file"
    )


def _effective_mode(s: FileStat) -> int:
    return posix_mode(s) & 0o7777


def _type_bits(s: FileStat) -> int:
    if s.type == FileType.DIRECTORY:
        return 0o040000
    if s.type == FileType.SYMLINK:
        return 0o120000
    if s.type == FileType.CHAR_DEVICE:
        return 0o020000
    return 0o100000


def _epoch(iso: str | None) -> str:
    if not iso:
        return "0"
    try:
        return str(iso_to_epoch(iso))
    except (ValueError, TypeError):
        return "0"


def _needs_escape(char: str) -> bool:
    """Whether GNU spells a character as a ``$'..'`` escape: a control
    character, or any byte past ASCII, as the C locale prints it.

    Args:
        char (str): the character to test.
    """
    return char < " " or char >= "\x7f"


def _escape_char(char: str) -> str:
    """Spell one character the way bash's ``$'..'`` does, a character
    past ASCII as the octal escape of each of its UTF-8 bytes.

    Args:
        char (str): the character to escape.
    """
    named = _ESCAPE_NAMES.get(char)
    if named is not None:
        return named
    raw = char.encode("utf-8", "surrogateescape")
    return "".join(f"\\{byte:03o}" for byte in raw)


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


def _apply_flags(
    value: str, flags: str, width: str, precision: str | None, text: bool
) -> str:
    """Apply GNU printf flags/width/precision to a rendered directive.

    Args:
        value (str): the raw directive value.
        flags (str): any of ``' - + space # 0 I``.
        width (str): minimum field width (digits) or empty.
        precision (str | None): precision digits, or None when absent.
        text (bool): the directive prints a string, which a precision
            cuts short.
    """
    if precision is not None and text:
        value = value[: int(precision)] if precision else ""
    if width and len(value) < int(width):
        w = int(width)
        if "-" in flags:
            value = value.ljust(w)
        elif "0" in flags and value not in _PLACEHOLDERS:
            value = value.rjust(w, "0")
        else:
            value = value.rjust(w)
    return value


def _directive_value(
    spec: str, s: FileStat, name: str, identity: Identity | None
) -> str:
    if spec == "%":
        return "%"
    if spec == "n":
        return name
    if spec == "s":
        return (
            "-" if not is_dir(s) and s.size is None else str(content_size(s))
        )
    if spec == "F":
        return _type_label(s)
    if spec == "a":
        return format(_effective_mode(s), "o")
    if spec == "A":
        return ls_mode_string(s)
    if spec == "f":
        return format(_type_bits(s) | _effective_mode(s), "x")
    if spec in ("u", "U"):
        return owner_name(s.uid, identity)
    if spec in ("g", "G"):
        return group_name(s.gid, identity)
    if spec == "x":
        return _stat_time(s.atime or s.modified)
    if spec == "X":
        return _epoch(s.atime or s.modified)
    if spec == "y":
        return _stat_time(s.modified)
    if spec == "Y":
        return _epoch(s.modified)
    if spec == "z":
        return _stat_time(s.ctime)
    if spec == "Z":
        return _epoch(s.ctime)
    if spec == "w":
        return _stat_time(s.birthtime)
    if spec == "W":
        return _epoch(s.birthtime)
    if spec == "B":
        return "512"
    dev = s.extra.get(DEVICE_NUMBERS_KEY) if s.extra else None
    if spec == "t":
        # rdev major in hex; a non-device has none, so 0 like GNU.
        return f"{dev[0]:x}" if dev else "0"
    if spec == "T":
        return f"{dev[1]:x}" if dev else "0"
    if spec in ("r", "R"):
        rdev = device_rdev(s)
        return str(rdev) if spec == "r" else f"{rdev:x}"
    if len(spec) == 2 and spec[0] in "HL":
        # %Hr/%Lr are rdev major/minor in decimal; %Hd/%Ld are the device
        # the file resides on, which a VFS has no truthful value for.
        if spec[1] in "rR":
            return str(dev[0 if spec[0] == "H" else 1]) if dev else "0"
        return "?"
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


def _render_directive(
    d: _FormatDirective, s: FileStat, name: str, identity: Identity | None
) -> str:
    """Render one directive with its flags, width and precision applied.

    Args:
        d (_FormatDirective): the parsed directive.
        s (FileStat): the stat being rendered.
        name (str): the operand as it was typed.
        identity (Identity | None): who the session is, for %U and %G
            on an entry that reports no owner of its own.
    """
    if d.spec not in _KNOWN:
        return "?"
    if d.spec == "N":
        # GNU formats the name and a symlink's target as two separate
        # fields, so a width pads each one rather than the joined line.
        bare = not d.flags and not d.width and d.precision is None
        return " -> ".join(
            _apply_flags(part, d.flags, d.width, d.precision, True)
            for part in _name_parts(s, name, bare)
        )
    value = _directive_value(d.spec, s, name, identity)
    if "#" in d.flags and d.spec == "a" and not value.startswith("0"):
        value = "0" + value
    return _apply_flags(
        value, d.flags, d.width, d.precision, d.spec in _STR_DIRECTIVES
    )


def _fs_blocks(nbytes: int | None) -> str:
    """A byte count as 1K blocks, rounded up like df, or '-' unknown.

    Args:
        nbytes (int | None): the byte count.
    """
    return "-" if nbytes is None else str(-(-nbytes // _FS_BLOCK))


def _fs_value(spec: str, kind: str, cap: CapacityResult, name: str) -> str:
    """One file-system directive's value.

    A mount has no file system ID, name limit, type number or transfer
    size, so those print '?'. Its counts print '-' unless it reports a
    quota, as df shows them.

    Args:
        spec (str): the conversion character.
        kind (str): the mount's VFS name, df's Type.
        cap (CapacityResult): the mount's capacity.
        name (str): the operand as it was typed.
    """
    if spec == "%":
        return "%"
    if spec == "n":
        return name
    if spec == "T":
        return kind
    if spec == "S":
        return str(_FS_BLOCK)
    if spec not in _FS_COUNTS:
        return "?"
    if cap.state != CapacityState.QUOTA:
        return "-"
    if spec == "b":
        return _fs_blocks(cap.total)
    if spec == "a":
        return _fs_blocks(cap.available)
    if spec == "f":
        if cap.total is None or cap.used is None:
            return "-"
        return _fs_blocks(cap.total - cap.used)
    if spec == "c":
        return "-" if cap.inodes is None else str(cap.inodes)
    if cap.inodes is None or cap.inodes_used is None:
        return "-"
    return str(cap.inodes - cap.inodes_used)


def _render_fs_directive(
    d: _FormatDirective, kind: str, cap: CapacityResult, name: str
) -> str:
    """Render one file-system directive with its flags applied.

    Args:
        d (_FormatDirective): the parsed directive.
        kind (str): the mount's VFS name.
        cap (CapacityResult): the mount's capacity.
        name (str): the operand as it was typed.
    """
    if d.spec not in _FS_KNOWN:
        return "?"
    return _apply_flags(
        _fs_value(d.spec, kind, cap, name),
        d.flags,
        d.width,
        d.precision,
        d.spec in _FS_STRINGS,
    )


def _parse_format_directive(
    fmt: str, start: int, halves: str
) -> _FormatDirective | None:
    """Scan one GNU printf-style directive starting at a ``%``.

    Walks flags, width and precision with an explicit cursor so a long run
    of flag/width characters that never reaches a conversion char costs
    linear time instead of backtracking (CodeQL #247). Any character
    converts, and one GNU does not know prints '?'.

    Args:
        fmt (str): the whole format string.
        start (int): index of the leading ``%``.
        halves (str): the conversions an ``H`` or ``L`` prefix takes.
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

    if cursor >= end:
        return None
    spec = fmt[cursor]
    cursor += 1
    if spec in ("H", "L") and cursor < end and fmt[cursor] in halves:
        spec += fmt[cursor]
        cursor += 1
    return _FormatDirective(
        end=cursor, flags=flags, width=width, precision=precision, spec=spec
    )


def _format(
    fmt: str, halves: str, render: Callable[[_FormatDirective], str]
) -> str:
    """Expand a format string, each directive through ``render``.

    Args:
        fmt (str): the format string.
        halves (str): the conversions an ``H`` or ``L`` prefix takes.
        render (Callable[[_FormatDirective], str]): one directive's text.
    """
    parts: list[str] = []
    cursor = 0
    while cursor < len(fmt):
        start = fmt.find("%", cursor)
        if start == -1:
            parts.append(fmt[cursor:])
            break
        parts.append(fmt[cursor:start])
        directive = _parse_format_directive(fmt, start, halves)
        if directive is None:
            parts.append("%")
            cursor = start + 1
            continue
        parts.append(render(directive))
        cursor = directive.end
    return "".join(parts)


def _format_stat(
    fmt: str, s: FileStat, name: str, identity: Identity | None
) -> str:
    return _format(
        fmt,
        _DEVICE_HALVES,
        partial(_render_directive, s=s, name=name, identity=identity),
    )


def _stat_time(value: str | None) -> str:
    """A known timestamp in GNU's layout, in UTC, or '-' when unknown.

    Args:
        value (str | None): backend ISO timestamp; a naive one is UTC.
    """
    if iso_timestamp(value) is None:
        return "-"
    return full_iso_time(value)


def _render_stat(s: FileStat, name: str, identity: Identity | None) -> str:
    """GNU coreutils 9.7's default layout, with unknown fields marked.

    A VFS has rendered bytes, modes and logical owners, but no device,
    inode, allocation blocks, IO block size or link count: those print
    '?'. An absent size, owner number or time prints '-'. Each time is
    the one its directive prints (``%x %y %z %w``), the name is unquoted
    as GNU's default prints it, and times are UTC.

    Args:
        s (FileStat): the backend and namespace stat.
        name (str): operand spelling.
        identity (Identity | None): session owner and group defaults.
    """
    size = _directive_value("s", s, name, identity)
    uid = str(s.uid) if s.uid is not None else "-"
    gid = str(s.gid) if s.gid is not None else "-"
    owner = owner_name(s.uid, identity)
    group = group_name(s.gid, identity)
    links = "Links: ?"
    if s.type is FileType.CHAR_DEVICE:
        major = _directive_value("Hr", s, name, identity)
        minor = _directive_value("Lr", s, name, identity)
        links = f"Links: {'?':<5} Device type: {major},{minor}"
    shown = " -> ".join(_name_parts(s, name, False))
    return (
        f"  File: {shown}\n"
        f"  Size: {size:<10}\tBlocks: {'?':<10} "
        f"IO Block: {'?':<6} {_type_label(s)}\n"
        f"Device: ?\tInode: {'?':<10}  {links}\n"
        f"Access: ({_effective_mode(s):04o}/{ls_mode_string(s)})  "
        f"Uid: ({uid:>5}/{owner:>8})   Gid: ({gid:>5}/{group:>8})\n"
        f"Access: {_stat_time(s.atime or s.modified)}\n"
        f"Modify: {_stat_time(s.modified)}\n"
        f"Change: {_stat_time(s.ctime)}\n"
        f" Birth: {_stat_time(s.birthtime)}"
    )


async def _dispatched_statfs(
    dispatch: DispatchFn, path: PathSpec
) -> tuple[str, CapacityResult]:
    """statfs through the op door.

    Args:
        dispatch (DispatchFn): the workspace op dispatcher.
        path (PathSpec): the operand.
    """
    result, _ = await dispatch("statfs", path)
    return cast(tuple[str, CapacityResult], result)


async def _file_systems(
    paths: list[PathSpec],
    fmt: str,
    probe: Callable[[PathSpec], Awaitable[FileStat]],
    statfs: StatfsFn | None,
) -> tuple[ByteSource | None, IOResult]:
    """Report the file system each operand is on, GNU ``stat -f``.

    The operand stat settles that a path exists first, so a missing one
    fails in the words a plain stat would find for it.

    Args:
        paths (list[PathSpec]): operands.
        fmt (str): the format, in the file-system directives.
        probe (Callable[[PathSpec], Awaitable[FileStat]]): the operand
            stat.
        statfs (StatfsFn | None): the type name and capacity of a path's
            mount; None outside a workspace.
    """
    lines: list[str] = []
    err = ""
    for p in paths:
        if p.raw_path == "-":
            err += f"stat: {_FS_STDIN}\n"
            continue
        try:
            await probe(p)
            kind, cap = (
                await statfs(p) if statfs is not None else _NO_FILE_SYSTEM
            )
        except FS_ERRORS as exc:
            strerror = fs_strerror(exc)
            err += (
                "stat: cannot read file system information for "
                f"{shell_quote_always(p.raw_path)}"
                f"{f': {strerror}' if strerror is not None else ''}\n"
            )
            continue
        render = partial(
            _render_fs_directive, kind=kind, cap=cap, name=p.raw_path
        )
        lines.append(_format(fmt, "", render))
    io = IOResult(exit_code=1 if err else 0, stderr=encode_text(err) or None)
    if not lines:
        return None, io
    return format_records(lines), io


async def stat(
    paths: list[PathSpec],
    *,
    stat_fn: Callable[..., Awaitable[FileStat]],
    c: str | None = None,
    f: bool = False,
    L: bool = False,
    links: LinkView | None = None,
    stat_path: StatPath | None = None,
    mounts: MountView | None = None,
    identity: Identity | None = None,
    statfs: StatfsFn | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Report file status, GNU stat semantics.

    Args:
        paths (list[PathSpec]): operands to stat.
        stat_fn (Callable): backend stat for a resolved path.
        c (str | None): output format string.
        f (bool): report the file system each operand is on instead.
        L (bool): dereference symlinks instead of reporting the link.
        links (LinkView | None): the namespace's symlink facts;
            absent when the workspace holds no links.
        stat_path (StatPath | None): dispatcher-backed stat of one path,
            which is what answers a directory that exists only because
            mounts sit under it.
        mounts (MountView | None): the mount boundaries, so a mount root
            reports its own name rather than the backend's name for its
            root.
        identity (Identity | None): who the session is: what ``%U`` and
            ``%G`` print for an entry that reports no uid or gid of its
            own; None outside a workspace, where both print ``-``.
        statfs (StatfsFn | None): the type name and capacity of the
            mount holding a path, for -f; None outside a workspace.
    """
    if not paths:
        raise missing_operand_error("stat", None)
    if f:
        probe = partial(
            operand_stat,
            stat_fn=stat_fn,
            stat_path=stat_path,
            mounts=mounts,
            links=links,
        )
        return await _file_systems(
            paths, _FS_LAYOUT if c is None else c, probe, statfs
        )
    lines: list[str] = []
    err = b""
    for p in paths:
        # GNU stat lstats: a symlink operand reports the link itself,
        # not its target, unless -L asks to dereference. A link has no
        # backend inode, so the namespace is the only authority for it.
        linked = None if L or links is None else links.stat_at(p.virtual)
        if linked is not None:
            if c is not None:
                lines.append(_format_stat(c, linked, p.raw_path, identity))
            else:
                lines.append(_render_stat(linked, p.raw_path, identity))
            continue
        try:
            s = await operand_stat(
                p,
                stat_fn=stat_fn,
                stat_path=stat_path,
                mounts=mounts,
                links=links,
            )
        except FS_ERRORS as exc:
            # GNU stat keeps reporting the remaining operands, exit 1.
            err += encode_text(fs_error_line("stat", p, exc))
            continue
        if c is not None:
            lines.append(_format_stat(c, s, p.raw_path, identity))
        else:
            lines.append(_render_stat(s, p.raw_path, identity))
    io = IOResult(exit_code=1 if err else 0, stderr=err or None)
    if not lines:
        return None, io
    return format_records(lines), io


__all__ = ["stat"]


@dataclass(frozen=True, slots=True)
class StatFlags:
    format: str | None = None
    file_system: bool = False
    deref: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> StatFlags:
    fl = FlagView(flags, spec=SPECS["stat"])
    return StatFlags(
        format=fl.as_str("format"),
        file_system=fl.as_bool("file_system"),
        deref=fl.as_bool("dereference"),
    )


async def stat_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    stat_fn: StatFn,
) -> tuple[ByteSource | None, IOResult]:
    parsed = parse_flags(opts.flags)
    statfs = (
        partial(_dispatched_statfs, opts.dispatch)
        if opts.dispatch is not None
        else None
    )
    return await stat(
        paths,
        stat_fn=stat_fn,
        c=parsed.format,
        f=parsed.file_system,
        L=parsed.deref,
        links=opts.ns.links if opts.ns is not None else None,
        stat_path=opts.stat_path,
        mounts=opts.ns.mounts if opts.ns is not None else None,
        identity=identity_of(opts),
        statfs=statfs,
    )
