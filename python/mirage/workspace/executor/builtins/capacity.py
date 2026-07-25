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

import math
from typing import Any, Callable

from mirage.commands.builtin.utils.formatting import _human_size
from mirage.types import CapacityResult, CapacityState, PathSpec
from mirage.utils.path import resolve_path
from mirage.workspace.executor.builtins.shared import (Result, fail, ok,
                                                       operand_text,
                                                       split_value_flags)
from mirage.workspace.mount.mount import MountEntry
from mirage.workspace.mount.registry import MountRegistry
from mirage.workspace.session import Session

_BLOCK_SUFFIX = {"K": 1024, "M": 1024**2, "G": 1024**3, "T": 1024**4}
_SI_UNITS = ("B", "K", "M", "G", "T")


def _parse_block(text: str) -> tuple[int, str] | None:
    """Parse a -B/--block-size argument into (bytes, header-label).

    Accepts a plain byte count or a 1024-based suffix (K/M/G/T), the way
    GNU labels the column after the raw argument (``-B1M`` -> ``1M-blocks``).

    Args:
        text (str): the -B argument as typed.
    """
    t = text.strip()
    if not t:
        return None
    suffix = t[-1].upper()
    if suffix in _BLOCK_SUFFIX:
        head = t[:-1] or "1"
        if not head.isdigit():
            return None
        value = int(head) * _BLOCK_SUFFIX[suffix]
    elif t.isdigit():
        value = int(t)
    else:
        return None
    # GNU rejects a zero (or non-positive) block size rather than scaling.
    if value <= 0:
        return None
    return value, t


def _last_format(args: list[str | PathSpec]) -> str | None:
    """The last size-format flag (-h/-H/-k/-B) in the leading option run.

    GNU df lets a later size flag override the earlier ones (``df -h -B1M``
    prints a block header, ``df -B1M -h`` prints ``Size``), so the display
    format is whichever of these appears last rather than a fixed
    precedence. Returns the flag letter, or None when none are present.

    Args:
        args (list[str | PathSpec]): args after the command name.
    """
    last: str | None = None
    i = 0
    while i < len(args):
        s = operand_text(args[i])
        if s == "--" or not (len(s) >= 2 and s[0] == "-" and s[1] != "-"):
            break
        body = s[1:]
        for j, c in enumerate(body):
            if c in "hHkB":
                last = c
            if c == "B":
                if not body[j + 1:]:
                    i += 1
                break
        i += 1
    return last


def _human_si(n: int) -> str:
    """Human-readable size in powers of 1000 (df -H), mirroring the 1024
    ``_human_size`` shape used by df -h / du -h.

    Args:
        n (int): byte count.
    """
    value = float(n)
    i = 0
    while value >= 1000 and i < len(_SI_UNITS) - 1:
        value /= 1000
        i += 1
    text = str(round(value)) if i == 0 else f"{value:.1f}"
    return f"{text}{_SI_UNITS[i]}"


def _scale(nbytes: int, block: int) -> str:
    """Bytes as a count of ``block``-byte units, rounded up like GNU df.

    Args:
        nbytes (int): byte count.
        block (int): block size in bytes.
    """
    return str(-(-nbytes // block))


def _use_pct(used: int, avail: int) -> str:
    """GNU df use-percent: ceil(used / (used + avail) * 100), or ``-`` when
    the denominator is zero.

    Args:
        used (int): used bytes.
        avail (int): available bytes.
    """
    denom = used + avail
    if denom <= 0:
        return "-"
    return f"{math.ceil(used * 100 / denom)}%"


def _num_cells(cap: CapacityResult, human: bool, si: bool, block: int,
               inodes: bool) -> list[str]:
    """The three numeric cells (block or inode) for one mount, or three
    ``-`` when capacity is not a known quota (never a fabricated 0).

    Args:
        cap (CapacityResult): the mount's capacity.
        human (bool): -h/-H human-readable sizes.
        si (bool): -H (powers of 1000) rather than -h (1024).
        block (int): block size in bytes for the non-human form.
        inodes (bool): -i inode columns instead of block columns.
    """
    quota = cap.state == CapacityState.QUOTA
    if inodes:
        if quota and cap.inodes is not None:
            return [
                str(cap.inodes),
                str(cap.inodes_used if cap.inodes_used is not None else 0),
                str(cap.inodes_free if cap.inodes_free is not None else 0),
            ]
        return ["-", "-", "-"]
    if quota and cap.total is not None:
        used = cap.used or 0
        avail = cap.available or 0
        if human:
            fmt = _human_si if si else _human_size
            return [fmt(cap.total), fmt(used), fmt(avail)]
        return [
            _scale(cap.total, block),
            _scale(used, block),
            _scale(avail, block)
        ]
    return ["-", "-", "-"]


def _pct_cell(cap: CapacityResult, inodes: bool) -> str:
    """The Use%/IUse% cell for one mount, or ``-`` outside a known quota.

    Args:
        cap (CapacityResult): the mount's capacity.
        inodes (bool): -i inode mode (percent over inodes).
    """
    if cap.state != CapacityState.QUOTA:
        return "-"
    if inodes:
        if cap.inodes is None:
            return "-"
        return _use_pct(cap.inodes_used or 0, cap.inodes_free or 0)
    if cap.total is None:
        return "-"
    return _use_pct(cap.used or 0, cap.available or 0)


async def _path_exists(dispatch: Callable[..., Any], spec: PathSpec) -> bool:
    """Whether a path resolves to an existing entry.

    GNU df errors on a missing FILE operand, so a deeper path is statted
    before its mount is accepted; a missing entry maps to False.

    Args:
        dispatch (Callable): op dispatcher.
        spec (PathSpec): the operand to stat.
    """
    try:
        await dispatch("stat", spec)
    except FileNotFoundError:
        return False
    return True


async def _target_mounts(registry: MountRegistry, dispatch: Callable[..., Any],
                         session: Session,
                         operands: list[str | PathSpec]) -> list[MountEntry]:
    """Resolve df operands to the mounts to report, deduped and ordered.

    No operand (or the workspace root ``/``) reports every mount; a path
    operand reports the mount that contains it, and a missing FILE raises
    ``FileNotFoundError`` carrying the operand as typed. Mirrors GNU df,
    which maps each FILE to its filesystem and lists all with no args.

    Args:
        registry (MountRegistry): mount registry.
        dispatch (Callable): op dispatcher (FILE existence check).
        session (Session): session providing cwd for relative operands.
        operands (list[str | PathSpec]): path operands.
    """
    ordered = sorted(registry.mounts(), key=lambda m: m.prefix)
    if not operands:
        return ordered
    seen: set[str] = set()
    out: list[MountEntry] = []
    for op in operands:
        if isinstance(op, PathSpec):
            virtual, label, spec = op.virtual, op.raw_path, op
        else:
            virtual = resolve_path(str(op), session.cwd)
            label, spec = str(op), PathSpec.from_str_path(virtual)
        if virtual in ("", "/"):
            for m in ordered:
                if m.prefix not in seen:
                    seen.add(m.prefix)
                    out.append(m)
            continue
        try:
            mount = registry.mount_for(virtual)
        except (KeyError, ValueError, FileNotFoundError):
            raise FileNotFoundError(label) from None
        # GNU df maps each FILE to its filesystem and errors on a missing
        # one. The mount root is the filesystem itself (always present); a
        # deeper path must exist, so stat it before accepting the mount.
        root = mount.prefix.rstrip("/") or "/"
        if virtual.rstrip("/") != root and not await _path_exists(
                dispatch, spec):
            raise FileNotFoundError(label)
        if mount.prefix not in seen:
            seen.add(mount.prefix)
            out.append(mount)
    return out


def _render_table(header: list[str], rows: list[list[str]],
                  show_type: bool) -> str:
    """GNU df column layout: Filesystem left-justified (min width 14), Type
    (when present) left, numeric columns right-justified, Mounted on left
    with no trailing pad, single-space separators.

    Args:
        header (list[str]): column headers.
        rows (list[list[str]]): one list of cells per mount.
        show_type (bool): whether column 1 is the Type column (left).
    """
    ncols = len(header)
    left = {0, ncols - 1}
    if show_type:
        left.add(1)
    widths = [
        max(len(header[c]), max((len(r[c]) for r in rows), default=0))
        for c in range(ncols)
    ]
    widths[0] = max(widths[0], 14)
    lines: list[str] = []
    for cells in [header, *rows]:
        parts: list[str] = []
        for c in range(ncols):
            if c == ncols - 1:
                parts.append(cells[c])
            elif c in left:
                parts.append(cells[c].ljust(widths[c]))
            else:
                parts.append(cells[c].rjust(widths[c]))
        lines.append(" ".join(parts))
    return "\n".join(lines) + "\n"


async def handle_df(
    registry: MountRegistry,
    session: Session,
    dispatch: Callable[..., Any],
    args: list[str | PathSpec],
) -> Result:
    """df [OPTION]... [FILE]...: report per-mount capacity.

    A mount reports real numbers only when its backend can (a real
    filesystem, or a provider exposing a quota); every other backend shows
    ``-`` rather than a fabricated total. Flags: -h/-H human sizes, -k/-B
    block size, -T backend type column, -i inodes, -P POSIX header, -a
    accepted no-op (mirage has no pseudo/duplicate mounts to hide).

    Args:
        registry (MountRegistry): mount registry (mount enumeration).
        session (Session): session providing cwd for relative operands.
        dispatch (Callable): op dispatcher (FILE existence check).
        args (list[str | PathSpec]): args after the command name.
    """
    flags, values, operands, bad = split_value_flags(args, "hHkiaTP", "B")
    if bad is not None:
        return fail("df", f"df: invalid option -- '{bad}'\n", 2)

    posix = "P" in flags
    b_parsed = None
    if "B" in values:
        b_parsed = _parse_block(values["B"])
        if b_parsed is None:
            return fail("df", f"df: invalid -B argument '{values['B']}'\n", 1)

    # GNU resolves the mutually overriding size flags last-wins, so -h/-H
    # (human) or -k/-B (block) is chosen by whichever appears last.
    last_fmt = _last_format(args)
    si = last_fmt == "H"
    human = last_fmt in ("h", "H")
    if last_fmt == "B" and b_parsed is not None:
        block, block_label = b_parsed[0], f"{b_parsed[1]}-blocks"
    else:
        block = 1024
        block_label = "1024-blocks" if posix else "1K-blocks"

    inodes = "i" in flags
    show_type = "T" in flags

    try:
        mounts = await _target_mounts(registry, dispatch, session, operands)
    except FileNotFoundError as exc:
        return fail("df", f"df: {exc}: No such file or directory\n", 1)

    if inodes:
        num_headers = ["Inodes", "IUsed", "IFree"]
        pct_header = "IUse%"
    elif human:
        num_headers = ["Size", "Used", "Avail"]
        pct_header = "Use%"
    else:
        num_headers = [block_label, "Used", "Available"]
        pct_header = "Capacity" if posix else "Use%"

    header = ["Filesystem"]
    if show_type:
        header.append("Type")
    header += num_headers + [pct_header, "Mounted on"]

    data: list[list[str]] = []
    for mount in mounts:
        cap = await mount.resource.statfs()
        cells = [mount.resource.name]
        if show_type:
            cells.append(mount.resource.name)
        cells += _num_cells(cap, human, si, block, inodes)
        cells.append(_pct_cell(cap, inodes))
        cells.append(mount.prefix.rstrip("/") or "/")
        data.append(cells)

    return ok("df", _render_table(header, data, show_type).encode())


__all__ = ["handle_df"]
