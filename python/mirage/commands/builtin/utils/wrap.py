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
from typing import Any, Callable

from mirage.types import PathSpec


def to_pathspec(path: Any, prefix: str = "") -> PathSpec:
    if isinstance(path, PathSpec):
        return path
    return PathSpec(original=path, directory=path, prefix=prefix)


async def call_readdir(
    readdir_fn: Callable,
    accessor: Any,
    path: Any,
    index: Any = None,
    prefix: str = "",
):
    return await readdir_fn(accessor, to_pathspec(path, prefix), index)


async def call_stat(
    stat_fn: Callable,
    accessor: Any,
    path: Any,
    index: Any = None,
    prefix: str = "",
):
    return await stat_fn(accessor, to_pathspec(path, prefix), index)


async def call_read_bytes(
    read_fn: Callable,
    accessor: Any,
    path: Any,
    index: Any = None,
    prefix: str = "",
) -> bytes:
    return await read_fn(accessor, to_pathspec(path, prefix), index)


async def stream_from_bytes(
    read_fn: Callable,
    accessor: Any,
    path: Any,
    index: Any = None,
    prefix: str = "",
) -> AsyncIterator[bytes]:
    yield await read_fn(accessor, to_pathspec(path, prefix), index)
