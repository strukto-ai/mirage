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
from functools import partial

from mirage.commands.builtin.generic.cp import cp as generic_cp
from mirage.commands.builtin.generic.mv import mv as generic_mv
from mirage.commands.builtin.generic_bind.adapter import CommandIO
from mirage.commands.builtin.utils.output import format_optional_records
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileType, PathSpec


async def _mkdir(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    p: bool = False,
    v: bool = False,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.ready(accessor) or not paths:
        raise ValueError("mkdir: missing operand")
    paths = await ops.resolve_glob(accessor, paths, index)
    lines: list[str] = []
    for path in paths:
        await ops.mkdir(accessor, path, parents=p)
        if v:
            lines.append(f"mkdir: created directory '{path.original}'")
    output = ("\n".join(lines) + "\n").encode() if lines else None
    return output, IOResult()


async def _touch(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    c: bool = False,
    r: str | None = None,
    d: str | None = None,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.ready(accessor) or not paths:
        raise ValueError("touch: missing operand")
    paths = await ops.resolve_glob(accessor, paths, index)
    for p in paths:
        if c:
            continue
        if not await ops.exists(accessor, p):
            await ops.write(accessor, p, b"")
    return None, IOResult()


async def _ln(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    s: bool = False,
    f: bool = False,
    n: bool = False,
    v: bool = False,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.ready(accessor) or len(paths) < 2:
        raise ValueError("ln: usage: ln [-s] [-f] source dest")
    paths = await ops.resolve_glob(accessor, paths, index)
    source_path = paths[0]
    dest_path = paths[1]
    if n and await ops.exists(accessor, dest_path):
        return None, IOResult()
    data = await ops.read_bytes(accessor, source_path)
    await ops.write(accessor, dest_path, data)
    output = f"'{source_path.original}' -> '{dest_path.original}'\n".encode(
    ) if v else None
    return output, IOResult(writes={dest_path.strip_prefix: data})


async def _rm(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    r: bool = False,
    R: bool = False,
    f: bool = False,
    v: bool = False,
    d: bool = False,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.ready(accessor) or not paths:
        raise ValueError("rm: missing operand")
    paths = await ops.resolve_glob(accessor, paths, index)
    recursive = r or R
    verbose_parts: list[str] = []
    removed: dict[str, bytes] = {}
    for p in paths:
        try:
            s = await ops.stat(accessor, p)
        except FileNotFoundError:
            if f:
                continue
            raise
        if s.type == FileType.DIRECTORY:
            if recursive:
                await ops.rm_r(accessor, p)
            elif d:
                await ops.rmdir(accessor, p)
            else:
                raise IsADirectoryError(
                    f"rm: cannot remove '{p.original}': Is a directory")
        else:
            await ops.unlink(accessor, p)
        removed[p.strip_prefix] = b""
        if v:
            verbose_parts.append(f"removed '{p.original}'")
    output = format_optional_records(verbose_parts) if v else None
    return output, IOResult(writes=removed)


async def _cp(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    r: bool = False,
    R: bool = False,
    a: bool = False,
    f: bool = False,
    n: bool = False,
    v: bool = False,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.ready(accessor) or len(paths) < 2:
        raise ValueError("cp: requires src and dst")
    paths = await ops.resolve_glob(accessor, paths, index)
    return await generic_cp(paths,
                            copy=partial(ops.copy, accessor),
                            find=partial(ops.find, accessor),
                            find_type="f",
                            stat=partial(ops.stat, accessor),
                            recursive=r or R or a,
                            n=n,
                            v=v,
                            index=index)


async def _mv(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    f: bool = False,
    n: bool = False,
    v: bool = False,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.ready(accessor) or len(paths) < 2:
        raise ValueError("mv: requires src and dst")
    paths = await ops.resolve_glob(accessor, paths, index)
    return await generic_mv(paths,
                            rename=partial(ops.rename, accessor),
                            stat=partial(ops.stat, accessor),
                            n=n,
                            v=v,
                            index=index)


# (name, builder, provision_builder, write, aggregate)
MUTATE_BUILDERS = (
    ("mkdir", _mkdir, None, True, None),
    ("touch", _touch, None, True, None),
    ("ln", _ln, None, True, None),
    ("rm", _rm, None, True, None),
    ("cp", _cp, None, True, None),
    ("mv", _mv, None, True, None),
)
