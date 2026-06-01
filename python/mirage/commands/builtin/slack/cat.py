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

from mirage.accessor.slack import SlackAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.cat import cat as generic_cat
from mirage.commands.builtin.slack._provision import file_read_provision
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.slack.glob import resolve_glob
from mirage.core.slack.read import read as slack_read
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import PathSpec


async def cat_provision(
    accessor: SlackAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> ProvisionResult:
    return await file_read_provision(
        accessor, paths,
        "cat " + " ".join(p.original if isinstance(p, PathSpec) else p
                          for p in paths))


@command("cat", resource="slack", spec=SPECS["cat"], provision=cat_provision)
async def cat(
    accessor: SlackAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    n: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if paths:
        paths = await resolve_glob(accessor, paths, index)
        reads = {
            p.strip_prefix: await slack_read(accessor, p, index)
            for p in paths
        }
        merged = b"".join(reads.values())
        io = IOResult(reads=reads, cache=list(reads))
        if n:
            return generic_cat(merged, number_lines=True), io
        return merged, io
    source = _resolve_source(stdin, "cat: missing operand")
    if n:
        return generic_cat(source, number_lines=True), IOResult()
    return source, IOResult()
