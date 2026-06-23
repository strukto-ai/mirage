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

from mirage.commands.builtin.aggregators import prefix_aggregate
from mirage.commands.builtin.generic.grep import grep as generic_grep
from mirage.commands.builtin.generic.rg import rg as generic_rg
from mirage.commands.builtin.generic.zgrep import zgrep as generic_zgrep
from mirage.commands.builtin.generic_bind.adapter import CommandIO
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def _grep(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    prefix: str = "",
    index: object = None,
    **flags: object,
) -> tuple[ByteSource | None, IOResult]:
    resolved = (await ops.resolve_glob(accessor, paths, index)
                if paths and ops.ready(accessor) else [])
    return await generic_grep(
        resolved,
        texts,
        flags,
        readdir=ops.readdir,
        stat=ops.stat,
        read_bytes=ops.read_bytes,
        read_stream=ops.read_stream,
        accessor=accessor,
        stdin=stdin,
        index=index,
    )


async def _rg(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    prefix: str = "",
    index: object = None,
    **flags: object,
) -> tuple[ByteSource | None, IOResult]:
    if paths and ops.ready(accessor):
        paths = await ops.resolve_glob(accessor, paths, index)
    return await generic_rg(
        paths,
        texts,
        flags,
        readdir=ops.readdir,
        stat=ops.stat,
        read_bytes=ops.read_bytes,
        read_stream=ops.read_stream,
        accessor=accessor,
        stdin=stdin,
        index=index,
    )


async def _zgrep(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    prefix: str = "",
    index: object = None,
    **flags: object,
) -> tuple[ByteSource | None, IOResult]:
    resolved = (await ops.resolve_glob(accessor, paths, index)
                if paths and ops.ready(accessor) else [])
    return await generic_zgrep(
        resolved,
        texts,
        flags,
        read_bytes=ops.read_bytes,
        accessor=accessor,
        stdin=stdin,
        index=index,
    )


# (name, builder, provision_builder, write, aggregate)
SEARCH_BUILDERS = (
    ("grep", _grep, None, False, prefix_aggregate),
    ("rg", _rg, None, False, None),
    ("zgrep", _zgrep, None, False, None),
)
