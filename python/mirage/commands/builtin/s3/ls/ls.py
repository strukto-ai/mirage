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

from mirage.accessor.s3 import S3Accessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.s3._provision import metadata_provision
from mirage.commands.builtin.utils.formatting import _human_size
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.s3.glob import resolve_glob
from mirage.core.s3.readdir import readdir
from mirage.core.s3.stat import stat
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileType, PathSpec


def _get_extension(path: str) -> str | None:
    dot = path.rfind(".")
    if dot == -1 or "/" in path[dot:]:
        return None
    return path[dot:]


async def _ls_entries(
    accessor: S3Accessor,
    path: PathSpec,
    all_files: bool,
    sort_by: str,
    reverse: bool,
    recursive: bool,
    list_dir: bool,
    warnings: list[str],
    index: IndexCacheStore = None,
):
    if list_dir:
        s = await stat(accessor, path, index)
        return [s]

    try:
        entries = await readdir(accessor, path, index)
    except (FileNotFoundError, ValueError) as exc:
        warnings.append(f"ls: cannot access '{path.original}': {exc}")
        return []

    stats = []
    for entry in entries:
        try:
            e_spec = PathSpec(original=entry,
                              directory=entry,
                              resolved=False,
                              prefix=path.prefix)
            s = await stat(accessor, e_spec, index)
        except (FileNotFoundError, ValueError) as exc:
            warnings.append(f"ls: cannot access '{entry}': {exc}")
            continue
        if not all_files and s.name.startswith("."):
            continue
        stats.append(s)

    if sort_by == "time":
        stats.sort(key=lambda s: s.modified or "", reverse=not reverse)
    elif sort_by == "size":
        stats.sort(key=lambda s: s.size or 0, reverse=not reverse)
    else:
        stats.sort(key=lambda s: s.name, reverse=reverse)

    if recursive:
        sub_entries = []
        for s in stats:
            sub_entries.append(s)
            if s.type == FileType.DIRECTORY:
                entry_path = path.child(s.name)
                entry_spec = PathSpec(original=entry_path,
                                      directory=entry_path,
                                      resolved=False,
                                      prefix=path.prefix)
                sub = await _ls_entries(accessor, entry_spec, all_files,
                                        sort_by, reverse, recursive, False,
                                        warnings, index)
                sub_entries.extend(sub)
        return sub_entries

    return stats


@command("ls", resource="s3", spec=SPECS["ls"], provision=metadata_provision)
async def ls(
    accessor: S3Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    args_l: bool = False,
    args_1: bool = False,
    a: bool = False,
    A: bool = False,
    h: bool = False,
    t: bool = False,
    S: bool = False,
    r: bool = False,
    R: bool = False,
    d: bool = False,
    F: bool = False,
    filetype_fns: dict | None = None,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    paths = await resolve_glob(accessor, paths, index)
    targets = [p for p in paths]
    all_files = a or A
    sort_by = "name"
    if t:
        sort_by = "time"
    elif S:
        sort_by = "size"
    warnings: list[str] = []
    results: list[str] = []
    for p in targets:
        p.prefix if isinstance(p, PathSpec) else ""
        try:
            entries = await _ls_entries(
                accessor,
                p,
                all_files,
                sort_by,
                r,
                R,
                d,
                warnings,
                index,
            )
        except (FileNotFoundError, ValueError) as exc:
            warnings.append(f"ls: cannot access '{p.original}': {exc}")
            continue
        if args_l and not args_1:
            for e in entries:
                ext = _get_extension(e.name)
                if filetype_fns and ext in filetype_fns:
                    try:
                        fn = filetype_fns[ext]
                        path_for_entry = (p.original if isinstance(
                            p, PathSpec) else p).rstrip("/") + "/" + e.name
                        stdout, _io = await fn(
                            accessor,
                            [path_for_entry],
                            args_l=True,
                        )
                        if stdout:
                            if isinstance(stdout, bytes):
                                results.append(stdout.decode(errors="replace"))
                            else:
                                chunks = [chunk async for chunk in stdout]
                                results.append(
                                    b"".join(chunks).decode(errors="replace"))
                            continue
                    except Exception:
                        pass
                size_str = _human_size(e.size or 0) if h else str(e.size or 0)
                line = (f"{e.type or '-'}\t{size_str}"
                        f"\t{e.modified or ''}\t{e.name}")
                results.append(line)
        else:
            for e in entries:
                is_dir = F and e.type == FileType.DIRECTORY
                name = e.name + "/" if is_dir else e.name
                results.append(name)
    stderr = "\n".join(warnings).encode() if warnings else None
    exit_code = 1 if warnings and not results else 0
    output = ("\n".join(results) + "\n").encode() if results else b""
    return output, IOResult(stderr=stderr, exit_code=exit_code)
