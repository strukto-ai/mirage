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

from functools import partial
from typing import Callable

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.utils.wrap import (call_read_bytes,
                                                call_read_stream)
from mirage.core.databricks_volume.path import backend_path
from mirage.core.databricks_volume.read import read_bytes as _read_bytes
from mirage.core.databricks_volume.stat import stat as _stat
from mirage.core.databricks_volume.stream import read_stream as _read_stream
from mirage.types import FileType, PathSpec


def path_prefix(paths: list[PathSpec],
                fallback: PathSpec | None = None) -> str:
    if paths:
        return paths[0].prefix
    if fallback is not None:
        return fallback.prefix
    return ""


async def is_directory(accessor: DatabricksVolumeAccessor,
                       path: PathSpec,
                       index: IndexCacheStore | None = None) -> bool:
    try:
        file_stat = await _stat(accessor, path, index)
    except FileNotFoundError:
        return False
    return file_stat.type == FileType.DIRECTORY


async def path_exists(accessor: DatabricksVolumeAccessor,
                      path: PathSpec,
                      index: IndexCacheStore | None = None) -> bool:
    try:
        await _stat(accessor, path, index)
    except FileNotFoundError:
        return False
    return True


def child_path(parent: PathSpec, name: str) -> PathSpec:
    base = parent.original.rstrip("/")
    return PathSpec.from_str_path(f"{base}/{name}", parent.prefix)


def same_backend_file(accessor: DatabricksVolumeAccessor, a: PathSpec,
                      b: PathSpec) -> bool:
    return backend_path(accessor.config, a) == backend_path(accessor.config, b)


def read_bytes_with_index(index: IndexCacheStore | None,
                          prefix: str = "") -> Callable:
    return partial(call_read_bytes, _read_bytes, index=index, prefix=prefix)


def read_stream_with_index(index: IndexCacheStore | None,
                           prefix: str = "") -> Callable:
    return partial(call_read_stream, _read_stream, index=index, prefix=prefix)
