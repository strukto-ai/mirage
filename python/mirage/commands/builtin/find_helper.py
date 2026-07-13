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

import fnmatch
import time
from datetime import datetime, timezone

from mirage.commands.builtin.utils.types import _Readdir, _Stat
from mirage.commands.errors import FindParseError
from mirage.types import FileType


def _parse_depth(value: str, flag: str) -> int:
    try:
        return int(value)
    except ValueError:
        raise FindParseError(
            f"find: invalid argument '{value}' to '{flag}'") from None


def _validate_size_mtime(size: str | None, mtime: str | None) -> None:
    if size is not None:
        _parse_size(size)
    if mtime is not None:
        _parse_mtime(mtime)


def _parse_size(spec: str) -> tuple[int | None, int | None]:
    # GNU rounds the file size up to whole units before comparing, and
    # +N / -N are strict: +N keeps ceil(size/unit) > N, -N keeps
    # ceil(size/unit) < N, N alone keeps ceil(size/unit) == N. Expressed
    # as inclusive byte bounds: +N -> [N*unit + 1, inf), -N ->
    # [0, (N-1)*unit], N -> [(N-1)*unit + 1, N*unit].
    suffixes = {"c": 1, "k": 1024, "M": 1024**2, "G": 1024**3}
    if spec.startswith(("+", "-")):
        raw = spec[1:]
    else:
        raw = spec
    digits = raw.rstrip("ckMG")
    if not digits:
        raise FindParseError(f"find: invalid argument '{spec}' to '-size'")
    mult = suffixes.get(raw[-1], 1)
    try:
        n = int(digits)
    except ValueError:
        raise FindParseError(
            f"find: invalid argument '{spec}' to '-size'") from None
    if spec.startswith("+"):
        return n * mult + 1, None
    if spec.startswith("-"):
        return None, (n - 1) * mult
    return (n - 1) * mult + 1, n * mult


def _parse_mtime(spec: str) -> tuple[float | None, float | None]:
    now = time.time()
    day = 86400
    try:
        n = int(spec.lstrip("+-"))
    except ValueError:
        raise FindParseError(
            f"find: invalid argument '{spec}' to '-mtime'") from None
    if spec.startswith("+"):
        return None, now - n * day
    if spec.startswith("-"):
        return now - n * day, None
    return now - (n + 1) * day, now - n * day


def _parse_modified(modified: str | None) -> float | None:
    if modified is None:
        return None
    dt = datetime.fromisoformat(modified)
    return dt.replace(tzinfo=timezone.utc).timestamp(
    ) if dt.tzinfo is None else dt.timestamp()


def _find_recursive(
    readdir: _Readdir,
    stat_fn: _Stat,
    path: str,
    name: str | None,
    ftype: str | None,
    min_size: int | None,
    max_size: int | None,
    maxdepth: int | None,
    name_exclude: str | None,
    or_names: list[str] | None,
    mtime_min: float | None,
    mtime_max: float | None,
    depth: int,
    acc: list[str],
    warnings: list[str] | None = None,
) -> None:
    if maxdepth is not None and depth > maxdepth:
        return
    try:
        entries = readdir(path)
    except (FileNotFoundError, ValueError) as exc:
        if warnings is not None:
            warnings.append(f"find: '{path}': {exc}")
        return
    for entry in entries:
        try:
            s = stat_fn(entry)
        except (FileNotFoundError, ValueError) as exc:
            if warnings is not None:
                warnings.append(f"find: '{entry}': {exc}")
            continue
        match = True
        if or_names:
            match = any(fnmatch.fnmatch(s.name, p) for p in or_names)
        elif name and not fnmatch.fnmatch(s.name, name):
            match = False
        if name_exclude and fnmatch.fnmatch(s.name, name_exclude):
            match = False
        if ftype == FileType.DIRECTORY and s.type != FileType.DIRECTORY:
            match = False
        elif ftype == "file" and s.type == FileType.DIRECTORY:
            match = False
        elif ftype and ftype not in ("file",
                                     FileType.DIRECTORY) and s.type != ftype:
            match = False
        if min_size is not None and (s.size is None or s.size < min_size):
            match = False
        if max_size is not None and (s.size is None or s.size > max_size):
            match = False
        if mtime_min is not None or mtime_max is not None:
            ts = _parse_modified(s.modified)
            if ts is None:
                match = False
            else:
                if mtime_min is not None and ts < mtime_min:
                    match = False
                if mtime_max is not None and ts > mtime_max:
                    match = False
        if match:
            acc.append(entry)
        if s.type == FileType.DIRECTORY:
            _find_recursive(readdir, stat_fn, entry, name, ftype, min_size,
                            max_size, maxdepth, name_exclude, or_names,
                            mtime_min, mtime_max, depth + 1, acc, warnings)


def find(
    readdir: _Readdir,
    stat_fn: _Stat,
    path: str,
    name: str | None = None,
    type: str | None = None,
    min_size: int | None = None,
    max_size: int | None = None,
    maxdepth: int | None = None,
    name_exclude: str | None = None,
    or_names: list[str] | None = None,
    mtime_min: float | None = None,
    mtime_max: float | None = None,
    warnings: list[str] | None = None,
) -> list[str]:
    results: list[str] = []
    _find_recursive(readdir, stat_fn, path, name, type, min_size, max_size,
                    maxdepth, name_exclude, or_names, mtime_min, mtime_max, 0,
                    results, warnings)
    return results
