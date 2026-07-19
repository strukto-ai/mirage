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

from collections.abc import Awaitable, Callable
from typing import Any

from mirage.accessor.base import Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.utils.output import format_optional_records
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def make_rm(
    *,
    resource: str,
    glob_fn: Callable[..., Awaitable[list[PathSpec]]],
    unlink: Callable[..., Awaitable[None]],
) -> Callable[..., Any]:
    """Build a file-only ``rm`` over an index-threaded unlink.

    For backends whose unlink resolves ids through the cache index; the
    factory rm builder calls ``ops.unlink(path)`` without an
    index, so those backends bind this wrapper instead.

    Args:
        resource (str): resource name the command registers under.
        glob_fn (Callable): backend resolve_glob ``(accessor, paths,
            index)``.
        unlink (Callable): backend unlink ``(accessor, path, index)``.
    """

    @command("rm", resource=resource, spec=SPECS["rm"], write=True)
    async def rm(
        accessor: Accessor,
        paths: list[PathSpec],
        *texts: str,
        f: bool = False,
        v: bool = False,
        index: IndexCacheStore = NULL_INDEX,
        **_extra: object,
    ) -> tuple[ByteSource | None, IOResult]:
        if not paths:
            raise ValueError("rm: missing operand")
        paths = await glob_fn(accessor, paths, index)
        verbose_parts: list[str] = []
        removed: dict[str, ByteSource] = {}
        for p in paths:
            try:
                await unlink(accessor, p, index)
            except (FileNotFoundError, ValueError):
                if f:
                    continue
                raise
            removed[p.mount_path] = b""
            if v:
                verbose_parts.append(f"removed '{p.virtual}'")
        output = format_optional_records(verbose_parts) if v else None
        return output, IOResult(writes=removed)

    return rm
