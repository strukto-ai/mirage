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

from mirage.accessor.langfuse import LangfuseAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.langfuse._provision import file_read_provision
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.langfuse.glob import resolve_glob
from mirage.core.langfuse.read import read as langfuse_read
from mirage.core.langfuse.scope import detect_scope
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import PathSpec


async def wc_provision(
    accessor: LangfuseAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> ProvisionResult:
    return await file_read_provision(
        accessor, paths,
        "wc " + " ".join(p.original if isinstance(p, PathSpec) else p
                         for p in paths))


@command("wc", resource="langfuse", spec=SPECS["wc"], provision=wc_provision)
async def wc(
    accessor: LangfuseAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    args_l: bool = False,
    w: bool = False,
    c: bool = False,
    m: bool = False,
    L: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if w or m or L:
        msg = "wc: only -l and -c supported for Langfuse"
        return None, IOResult(
            exit_code=1,
            stderr=msg.encode(),
        )

    if not paths:
        raise ValueError("wc: missing operand")

    scope = detect_scope(paths[0])

    if scope.level == "file":
        paths = await resolve_glob(accessor, paths)
        p = paths[0]
        data = await langfuse_read(
            accessor,
            p,
            index,
        )
        if c:
            return str(len(data)).encode(), IOResult()
        line_count = data.count(b"\n")
        return str(line_count).encode(), IOResult()

    raise ValueError("wc: path must target a file")
