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

from mirage.accessor.redis import RedisAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.redis.glob import resolve_glob
from mirage.core.redis.rm import rm_r
from mirage.core.redis.rmdir import rmdir
from mirage.core.redis.stat import stat
from mirage.core.redis.unlink import unlink
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileType, PathSpec


@command("rm", resource="redis", spec=SPECS["rm"], write=True)
async def rm(
    accessor: RedisAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    r: bool = False,
    R: bool = False,
    f: bool = False,
    v: bool = False,
    d: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if accessor.store is None or not paths:
        raise ValueError("rm: missing operand")
    paths = await resolve_glob(accessor, paths, index)
    recursive = r or R
    verbose_parts: list[str] = []
    removed: dict[str, bytes] = {}
    for p in paths:
        try:
            s = await stat(accessor, p)
        except FileNotFoundError:
            if f:
                continue
            raise
        if s.type == FileType.DIRECTORY:
            if recursive:
                await rm_r(accessor, p)
            elif d:
                await rmdir(accessor, p)
            else:
                raise IsADirectoryError(
                    f"rm: cannot remove '{p.original}': Is a directory")
        else:
            await unlink(accessor, p)
        removed[p.strip_prefix] = b""
        if v:
            verbose_parts.append(f"removed '{p.original}'")
    output = "\n".join(verbose_parts).encode() if v else None
    return output, IOResult(writes=removed)
