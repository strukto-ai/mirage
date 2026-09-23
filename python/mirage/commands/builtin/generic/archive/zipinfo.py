# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

from dataclasses import dataclass
from typing import Literal

# Info-ZIP zipinfo's short-listing vocabulary (zipinfo.c, zi_short),
# indexed by the host byte of "version made by" and by compression
# method. A host past the table reads as the last "???" slot, as the
# MIN(host, NUM_HOSTS) clamp does there.
HOSTS = ("fat", "ami", "vms", "unx", "cms", "atr", "hpf", "mac", "zzz", "cpm",
         "t20", "ntf", "qds", "aco", "vft", "mvs", "be ", "nsk", "ths", "osx",
         "???", "???", "???", "???", "???", "???", "???", "???", "???", "???",
         "ath", "???")
METHODS = {
    0: "stor",
    1: "shrk",
    2: "re:1",
    3: "re:2",
    4: "re:3",
    5: "re:4",
    6: "i#:#",
    7: "tokn",
    8: "def#",
    9: "d64#",
    10: "dcli",
    12: "bzp2",
    14: "lzma",
    18: "ters",
    19: "lz77",
    97: "wavp",
    98: "ppmd",
}
DEFLATE_LEVELS = "NXFS"
MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct",
          "Nov", "Dec")
# Hosts whose external attributes are DOS attribute bytes rather than a
# Unix mode: FS_FAT_, VM_CMS_, FS_HPFS_, FS_NTFS_, ACORN_, FS_VFAT_,
# MVS_. VMS, Amiga and Theos have their own layouts in zipinfo.c and are
# rendered here as Unix modes, the "assume Unix-like" default branch.
DOS_HOSTS = frozenset({0, 4, 6, 11, 13, 14, 15})
UNIX_TIME_HOSTS = frozenset({3, 6, 11})
DOS_EXECUTABLE_SUFFIXES = ("com", "exe", "btm", "cmd", "bat")


@dataclass(frozen=True, slots=True)
class ZipRow:
    """One central-directory entry as zipinfo reads it.

    Args:
        name (str): the member name, directories with their trailing slash.
        size (int): uncompressed size.
        csize (int): compressed size.
        method (int): compression method id.
        flags (int): general-purpose bit flags.
        internal_attr (int): internal file attributes.
        external_attr (int): the whole 32-bit external attributes word.
        host (int): the host byte of "version made by".
        host_version (int): the version byte of "version made by", tenths.
        date_time (tuple[int, int, int, int, int, int]): the DOS stamp
            decoded as (year, month, day, hour, minute, second), month
            and day left at 0 when the stamp is 0.
        has_extra (bool): whether the central entry carries an extra field.
    """
    name: str
    size: int
    csize: int
    method: int
    flags: int
    internal_attr: int
    external_attr: int
    host: int
    host_version: int
    date_time: tuple[int, int, int, int, int, int]
    has_extra: bool


ZipinfoRows = Literal["none", "names", "short", "medium", "long"]


@dataclass(frozen=True, slots=True)
class ZipinfoLayout:
    """What one zipinfo run prints: rows, header, totals.

    Args:
        rows (ZipinfoRows): which row format, if any.
        header (bool): print the ``Archive:`` and ``Zip file size`` lines.
        totals (bool): print the trailing totals line.
    """
    rows: ZipinfoRows
    header: bool
    totals: bool


def zipinfo_layout(*, names_only: bool, names_headers: bool, long: bool,
                   medium: bool, short: bool, header: bool, totals: bool,
                   has_members: bool) -> ZipinfoLayout:
    """Resolve zipinfo's -1/-2/-s/-m/-l/-h/-t interplay (zipinfo.c, zi_opts).

    -1 prints names and nothing else, whatever -h/-t say. -2 prints
    names plus whichever of the header and totals was asked for. The
    row formats default both on, except that naming members (or
    excluding some) turns off the one not asked for explicitly. -h or
    -t alone (no row format) prints just that, unless members are
    named, in which case the default rows come too. Info-ZIP reads the
    letters in order and the last row format wins; the flag bag has no
    order, so -1 beats -2 beats -l beats -m beats -s here.

    Args:
        names_only (bool): ``-1``.
        names_headers (bool): ``-2``.
        long (bool): ``-l``.
        medium (bool): ``-m``.
        short (bool): ``-s``, the default rows asked for by name.
        header (bool): ``-h``.
        totals (bool): ``-t``.
        has_members (bool): whether member or exclude patterns were given.
    """
    if names_only:
        return ZipinfoLayout("names", False, False)
    if names_headers:
        return ZipinfoLayout("names", header, totals)
    rows: ZipinfoRows
    if long:
        rows = "long"
    elif medium:
        rows = "medium"
    elif short:
        rows = "short"
    elif header or totals:
        if not has_members:
            return ZipinfoLayout("none", header, totals)
        rows = "short"
    else:
        rows = "short"
    return ZipinfoLayout(rows, not (has_members and not header),
                         not (has_members and not totals))


def _unix_attribs(xattr: int) -> str:
    kind = {
        0o040000: "d",
        0o100000: "-",
        0o120000: "l",
        0o060000: "b",
        0o020000: "c",
        0o010000: "p",
        0o140000: "s",
    }.get(xattr & 0o170000, "?")
    out = [kind]
    for read, write, exe, special, lower, upper in (
        (0o400, 0o200, 0o100, 0o4000, "s", "S"),
        (0o040, 0o020, 0o010, 0o2000, "s", "S"),
        (0o004, 0o002, 0o001, 0o1000, "t", "T"),
    ):
        out.append("r" if xattr & read else "-")
        out.append("w" if xattr & write else "-")
        if xattr & exe:
            out.append(lower if xattr & special else "x")
        else:
            out.append(upper if xattr & special else "-")
    return "".join(out)


def _dos_attribs(external_attr: int, name: str) -> str:
    lo = external_attr & 0xFF
    out = list(".r.-...")
    out[2] = "-" if lo & 0x01 else "w"
    out[5] = "h" if lo & 0x02 else "-"
    out[6] = "s" if lo & 0x04 else "-"
    out[4] = "a" if lo & 0x20 else "-"
    if lo & 0x10:
        out[0] = "d"
        out[3] = "x"
    else:
        out[0] = "-"
    if lo & 0x08:
        out[0] = "V"
    else:
        suffix = name.rsplit(".", 1)[-1] if "." in name else ""
        if suffix[:3].lower() in DOS_EXECUTABLE_SUFFIXES:
            out[3] = "x"
    return "".join(out).ljust(10)


def _attribs(row: ZipRow) -> str:
    xattr = (row.external_attr >> 16) & 0xFFFF
    # A FAT host whose Unix bits merely restate its DOS attribute byte
    # (read, write unless read-only, execute when a directory) has no
    # mode of its own to show, so zipinfo renders the DOS byte instead.
    dos_shadow = 0o400 | ((0 if row.external_attr & 1 else 1) << 7) | (
        (row.external_attr & 0x10) << 2)
    if row.host in DOS_HOSTS and (row.host != 0 or
                                  (xattr & 0o700) != dos_shadow):
        perms = _dos_attribs(row.external_attr, row.name)
    else:
        perms = _unix_attribs(xattr)
    return f"{perms}  {row.host_version // 10}.{row.host_version % 10}"


def _method(row: ZipRow) -> str:
    text = METHODS.get(row.method)
    if text is None:
        return f"u{row.method:03d}"
    if row.method == 6:
        return (f"i{'8' if row.flags & 2 else '4'}:"
                f"{'3' if row.flags & 4 else '2'}")
    if row.method in (8, 9):
        return text[:3] + DEFLATE_LEVELS[(row.flags >> 1) & 3]
    return text


def _stamp(row: ZipRow) -> str:
    year, month, day, hour, minute, _ = row.date_time
    month_text = MONTHS[month - 1] if 0 < month <= 12 else f"{month:03d}"
    return f"{year % 100:02d}-{month_text}-{day:02d} {hour:02d}:{minute:02d}"


def _kind_flags(row: ZipRow) -> str:
    text = bool(row.internal_attr & 1)
    if row.flags & 1:
        first = "T" if text else "B"
    else:
        first = "t" if text else "b"
    extra = row.has_extra or (bool(row.external_attr & 0x8000)
                              and row.host in UNIX_TIME_HOSTS)
    if row.flags & 8:
        second = "X" if extra else "l"
    else:
        second = "x" if extra else "-"
    return first + second


def _compressed(row: ZipRow) -> int:
    """Compressed bytes as zipinfo counts them: minus an encryption header.

    Args:
        row (ZipRow): the entry.
    """
    return row.csize - (12 if row.flags & 1 else 0)


def render_row(row: ZipRow, fmt: ZipinfoRows) -> str:
    """One ``ls -l``-shaped zipinfo line.

    ``medium`` (``-m``) adds the percent saved, ``long`` (``-l``) the
    compressed size; ``short`` (``-s``) is the bare row. The percent is
    ``(ratio + 5) / 10`` in C integer division, which truncates toward
    zero, so a growth of -199.5% prints as ``-199%``.

    Args:
        row (ZipRow): the entry.
        fmt (ZipinfoRows): ``"short"``, ``"medium"`` or ``"long"``.
    """
    host = HOSTS[min(row.host, len(HOSTS) - 1)]
    line = f"{_attribs(row)} {host} {row.size:>8} {_kind_flags(row)}"
    if fmt == "medium":
        percent = int((compression_ratio(row.size, _compressed(row)) + 5) / 10)
        line += f"{percent:>3}%"
    elif fmt == "long":
        line += f" {row.csize:>8}"
    return f"{line} {_method(row)} {_stamp(row)} {row.name}"


def render_header(archive: str, zip_size: int, entries: int) -> str:
    """The two ``-h`` lines.

    Args:
        archive (str): the archive operand as typed.
        zip_size (int): the archive's byte length.
        entries (int): the central directory's entry count.
    """
    return (f"Archive:  {archive}\n"
            f"Zip file size: {zip_size} bytes, number of entries: {entries}\n")


def compression_ratio(uncompressed: int, compressed: int) -> int:
    """Info-ZIP's ``ratio()``: tenths of a percent saved, rounded, signed.

    Args:
        uncompressed (int): total uncompressed bytes.
        compressed (int): total compressed bytes.
    """
    if uncompressed == 0:
        return 0
    if uncompressed > 2_000_000:
        denom = uncompressed // 1000
        if uncompressed >= compressed:
            return (uncompressed - compressed + (denom >> 1)) // denom
        return -((compressed - uncompressed + (denom >> 1)) // denom)
    if uncompressed >= compressed:
        return (1000 * (uncompressed - compressed) +
                (uncompressed >> 1)) // uncompressed
    return -((1000 * (compressed - uncompressed) +
              (uncompressed >> 1)) // uncompressed)


def render_totals(rows: list[ZipRow]) -> str:
    """The ``-t`` line over the listed rows.

    An encrypted entry's 12-byte header is not counted as compressed
    data, as zipinfo does not count it.

    Args:
        rows (list[ZipRow]): the entries that were listed.
    """
    uncompressed = sum(r.size for r in rows)
    compressed = sum(_compressed(r) for r in rows)
    ratio = compression_ratio(uncompressed, compressed)
    sign = "-" if ratio < 0 else ""
    ratio = abs(ratio)
    plural = "" if len(rows) == 1 else "s"
    return (f"{len(rows)} file{plural}, {uncompressed} bytes uncompressed, "
            f"{compressed} bytes compressed:  {sign}{ratio // 10}."
            f"{ratio % 10}%\n")


__all__ = [
    "ZipRow",
    "ZipinfoLayout",
    "zipinfo_layout",
    "render_row",
    "render_header",
    "render_totals",
    "compression_ratio",
]
