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

from mirage.accessor.base import Accessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.tar import tar as generic_tar
from mirage.commands.builtin.generic_bind.adapter import Builder, CommandIO
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def tar(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    c: bool = False,
    x: bool = False,
    t: bool = False,
    z: bool = False,
    j: bool = False,
    J: bool = False,
    v: bool = False,
    f: PathSpec | None = None,
    C: PathSpec | None = None,
    strip_components: str | None = None,
    exclude: str | None = None,
    index: IndexCacheStore | None = None,
    **flags,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.is_mounted(accessor):
        raise ValueError("tar: missing operand")
    paths = await ops.resolve_glob(accessor, paths, index)
    return await generic_tar(paths,
                             read_bytes=ops.read_bytes,
                             write_bytes=ops.write,
                             mkdir_fn=ops.mkdir,
                             accessor=accessor,
                             c=c,
                             x=x,
                             t=t,
                             z=z,
                             j=j,
                             J=J,
                             v=v,
                             f=f,
                             C=C,
                             strip_components=strip_components,
                             exclude=exclude)


BUILDER = Builder('tar', tar, None, True, None)
