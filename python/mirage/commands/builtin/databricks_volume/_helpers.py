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

from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.utils.wrap import call_read_bytes
from mirage.core.databricks_volume.read import read_bytes as _read_bytes
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of


def path_prefix(paths: list[PathSpec],
                fallback: PathSpec | None = None) -> str:
    if paths:
        return mount_prefix_of(paths[0].virtual, paths[0].resource_path)
    if fallback is not None:
        return mount_prefix_of(fallback.virtual, fallback.resource_path)
    return ""


def read_bytes_with_index(index: IndexCacheStore | None,
                          prefix: str = "") -> Callable:
    return partial(call_read_bytes, _read_bytes, index=index, prefix=prefix)
