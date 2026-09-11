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

from datetime import datetime, timezone
from stat import filemode

from mirage.commands.builtin.utils.identity import (Identity, group_name,
                                                    owner_name)
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.dates import iso_timestamp
from mirage.utils.stat_view import CHAR_MODE, DIR_MODE, FILE_MODE, LINK_MODE

_PRINTF_ESCAPES = {
    "n": "\n",
    "t": "\t",
    "r": "\r",
    "0": "\0",
    "\\": "\\",
    "a": "\a",
    "b": "\b",
    "f": "\f",
    "v": "\v",
}
_STAT_DIRECTIVES = frozenset("syYmMTuUgG")
_TYPE_LETTER = {
    FileType.DIRECTORY: "d",
    FileType.SYMLINK: "l",
    FileType.CHAR_DEVICE: "c",
    FileType.BLOCK_DEVICE: "b",
    FileType.FIFO: "p",
    FileType.SOCKET: "s",
}
# One mode per kind, spelled from the same constants every stat
# translator uses (utils/stat_view.py); links are 777 the way ls draws
# them.
_KIND_MODE = {
    "c": CHAR_MODE,
    "d": DIR_MODE,
    "l": LINK_MODE,
    "f": FILE_MODE,
}


def printf_needs_stat(fmt: str) -> bool:
    """Whether a -printf format reads anything off the entry's stat.

    Args:
        fmt (str): the format string as typed.
    """
    i = 0
    while i < len(fmt) - 1:
        if fmt[i] == "%" and fmt[i + 1] in _STAT_DIRECTIVES:
            return True
        if fmt[i] in ("%", "\\"):
            i += 2
            continue
        i += 1
    return False


def _relative_part(row: str, search: PathSpec) -> str:
    base = search.raw_path or search.virtual
    if row == base:
        return ""
    stem = base if base.endswith("/") else base + "/"
    if row.startswith(stem):
        return row[len(stem):]
    return row


def _mtime_epoch(st: FileStat | None) -> float:
    if st is None or st.modified is None:
        return 0.0
    return iso_timestamp(st.modified) or 0.0


def _expand_time(letter: str, ts: float, directive_src: str,
                 warnings: list[str]) -> str:
    if letter == "@":
        return f"{ts:.10f}"
    dt = datetime.fromtimestamp(ts, timezone.utc)
    if letter == "+":
        frac = f"{ts:.10f}".split(".")[1]
        return dt.strftime("%Y-%m-%d+%H:%M:%S") + "." + frac
    try:
        return dt.strftime(f"%{letter}")
    except ValueError:
        _warn_unrecognized(directive_src, warnings)
        return directive_src


def _warn_unrecognized(src: str, warnings: list[str]) -> None:
    kind = "escape" if src.startswith("\\") else "format directive"
    line = f"find: warning: unrecognized {kind} '{src}'"
    if line not in warnings:
        warnings.append(line)


def printf_kind(st: FileStat | None) -> str:
    """The one-letter kind a -printf %y/%Y directive renders for a stat.

    Args:
        st (FileStat | None): the row's stat, None when unknown.
    """
    if st is None or st.type is None:
        return "f"
    return _TYPE_LETTER.get(st.type, "f")


def _mode_bits(st: FileStat | None, kind: str) -> int:
    # The kind fixes the type bits; a reported mode (chmod overlay, a
    # backend that knows) supplies the permission bits, else the
    # per-kind default every stat translator uses.
    base = _KIND_MODE[kind]
    if st is None or st.mode is None:
        return base
    return (base & ~0o7777) | (st.mode & 0o7777)


def expand_printf(fmt: str,
                  row: str,
                  search: PathSpec,
                  st: FileStat | None,
                  warnings: list[str],
                  target: FileStat | None = None,
                  identity: Identity | None = None) -> str:
    """Expand one -printf format against one result row.

    Directives cover what GNU's find agents actually use: the path family
    (%p %P %f %h %d), the stat family (%s %y %Y %m %M), the owner family
    (%u %U %g %G, which read the entry's uid and gid and fall back to
    the workspace user and the session's profile, the same rule
    ``ls -l`` draws its columns by), %T times, and the backslash
    escapes. An unrecognized directive or escape renders
    literally and adds GNU's warning line once, exit code untouched --
    which is GNU's own behavior. Times render in UTC (mirage timestamps
    are zone-carrying ISO strings; GNU renders the local zone). ``%Y``
    on a symlink row reports the target's kind, ``N`` when the link
    dangles; on any other row it is ``%y``.

    Args:
        fmt (str): the format string as typed.
        row (str): the display row (operand-respelled).
        search (PathSpec): the start point the row came from.
        st (FileStat | None): the row's stat, when the format needs one.
        warnings (list[str]): sink for GNU's warning lines, deduplicated.
        target (FileStat | None): a symlink row's resolved target stat,
            None when the link dangles; ignored for non-link rows.
        identity (Identity | None): who the session is, for the owner
            family on an entry that reports no owner of its own.
    """
    out: list[str] = []
    i = 0
    n = len(fmt)
    kind = printf_kind(st)
    while i < n:
        ch = fmt[i]
        if ch == "\\" and i + 1 < n:
            nxt = fmt[i + 1]
            if nxt in _PRINTF_ESCAPES:
                out.append(_PRINTF_ESCAPES[nxt])
            else:
                _warn_unrecognized(f"\\{nxt}", warnings)
                out.append(fmt[i:i + 2])
            i += 2
            continue
        if ch != "%" or i + 1 >= n:
            out.append(ch)
            i += 1
            continue
        code = fmt[i + 1]
        i += 2
        if code == "%":
            out.append("%")
        elif code == "p":
            out.append(row)
        elif code == "P":
            out.append(_relative_part(row, search))
        elif code == "f":
            trimmed = row.rstrip("/")
            out.append(trimmed.rsplit("/", 1)[-1] if trimmed else "/")
        elif code == "h":
            trimmed = row.rstrip("/")
            if "/" not in trimmed:
                out.append("." if trimmed else "/")
            else:
                head = trimmed.rsplit("/", 1)[0]
                out.append(head if head else "/")
        elif code == "d":
            rel = _relative_part(row, search)
            out.append("0" if not rel else str(rel.count("/") + 1))
        elif code == "s":
            out.append(str((st.size if st is not None else 0) or 0))
        elif code == "y":
            out.append("U" if st is None else kind)
        elif code == "Y":
            if st is None:
                out.append("U")
            elif kind == "l":
                out.append("N" if target is None else printf_kind(target))
            else:
                out.append(kind)
        elif code in ("u", "U"):
            out.append(owner_name(st.uid if st is not None else None,
                                  identity))
        elif code in ("g", "G"):
            out.append(group_name(st.gid if st is not None else None,
                                  identity))
        elif code == "m":
            out.append(format(_mode_bits(st, kind) & 0o7777, "o"))
        elif code == "M":
            out.append(filemode(_mode_bits(st, kind)))
        elif code == "T" and i < n:
            letter = fmt[i]
            i += 1
            out.append(
                _expand_time(letter, _mtime_epoch(st), f"%T{letter}",
                             warnings))
        else:
            _warn_unrecognized(f"%{code}", warnings)
            out.append(f"%{code}")
    return "".join(out)
