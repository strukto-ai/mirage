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

from collections.abc import AsyncIterator

from mirage.accessor.gdrive import GDriveAccessor
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.gdrive.glob import resolve_glob
from mirage.core.gdrive.read import read as gdrive_read
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _build_join_map(lines, field_idx, delimiter):
    result: dict[str, list[list[str]]] = {}
    for line in lines:
        parts = line.split(delimiter) if delimiter else line.split()
        if field_idx < len(parts):
            key = parts[field_idx]
            rest = parts[:field_idx] + parts[field_idx + 1:]
            if key not in result:
                result[key] = []
            result[key].append(rest)
    return result


def _format_row(key, rest1, rest2, o_fmt, out_sep):
    if o_fmt is None:
        return out_sep.join([key] + rest1 + rest2)
    fields: list[str] = []
    for spec in o_fmt.split(","):
        spec = spec.strip()
        if spec == "0":
            fields.append(key)
        else:
            f_parts = spec.split(".", 1)
            file_n = int(f_parts[0])
            field_m = int(f_parts[1]) - 1
            src = rest1 if file_n == 1 else rest2
            if field_m < len(src):
                fields.append(src[field_m])
            else:
                fields.append("")
    return out_sep.join(fields)


def _join_lines(lines1, lines2, field1, field2, sep, a, v, e, o):
    map1 = _build_join_map(lines1, field1, sep)
    map2 = _build_join_map(lines2, field2, sep)
    out_sep = sep if sep else " "
    out_lines: list[str] = []
    matched_keys2: set[str] = set()
    for line in lines1:
        parts = line.split(sep) if sep else line.split()
        if field1 >= len(parts):
            continue
        key = parts[field1]
        rest1 = parts[:field1] + parts[field1 + 1:]
        if key in map2:
            matched_keys2.add(key)
            if v is None:
                for rest2 in map2[key]:
                    out_lines.append(_format_row(key, rest1, rest2, o,
                                                 out_sep))
        else:
            if v == "1" or a == "1":
                if o is not None and e is not None and map2:
                    sample = map2[next(iter(map2))][0]
                    placeholder = [e] * len(sample)
                else:
                    placeholder = []
                out_lines.append(
                    _format_row(key, rest1, placeholder, o, out_sep))
    if a == "2" or v == "2":
        for line in lines2:
            parts = line.split(sep) if sep else line.split()
            if field2 >= len(parts):
                continue
            key = parts[field2]
            if key not in matched_keys2:
                rest2 = parts[:field2] + parts[field2 + 1:]
                if o is not None and e is not None and map1:
                    sample = map1[next(iter(map1))][0]
                    placeholder = [e] * len(sample)
                else:
                    placeholder = []
                out_lines.append(
                    _format_row(key, placeholder, rest2, o, out_sep))
    return out_lines


@command("join", resource="gdrive", spec=SPECS["join"])
async def join(
    accessor: GDriveAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    t: str | None = None,
    a: str | None = None,
    v: str | None = None,
    e: str | None = None,
    o: str | None = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if len(paths) < 2:
        raise ValueError("join: requires two paths")
    paths = await resolve_glob(accessor, paths, _extra.get("index"))
    field1 = int(_extra.get("args_1", 1)) - 1
    field2 = int(_extra.get("2", 1)) - 1
    sep = t
    p0 = paths[0]
    p1 = paths[1]
    data1 = (await gdrive_read(
        accessor,
        p0.original,
        _extra.get("index"),
    )).decode(errors="replace")
    data2 = (await gdrive_read(
        accessor,
        p1.original,
        _extra.get("index"),
    )).decode(errors="replace")
    lines1 = data1.splitlines()
    lines2 = data2.splitlines()
    out_lines = _join_lines(lines1, lines2, field1, field2, sep, a, v, e, o)
    if not out_lines:
        return None, IOResult()
    output = "\n".join(out_lines) + "\n"
    return output.encode(), IOResult()
