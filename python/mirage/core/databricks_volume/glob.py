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

import fnmatch
import logging
import posixpath

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.databricks_volume.readdir import readdir
from mirage.types import PathSpec

logger = logging.getLogger(__name__)
SCOPE_ERROR = 10_000


async def resolve_glob(
    accessor: DatabricksVolumeAccessor,
    paths: list[PathSpec],
    index: IndexCacheStore,
) -> list[PathSpec]:
    result: list[PathSpec] = []
    for path in paths:
        if isinstance(path, str):
            result.append(
                PathSpec(original=path, directory=posixpath.dirname(path)))
            continue
        if path.resolved:
            result.append(path)
        elif path.pattern:
            entries = await readdir(accessor, path.dir, index)
            matched = [
                PathSpec.from_str_path(entry, path.prefix) for entry in entries
                if fnmatch.fnmatch(entry.rsplit("/", 1)[-1], path.pattern)
            ]
            if len(matched) > SCOPE_ERROR:
                logger.warning(
                    "%s: %d matches exceeds limit (%d), truncating",
                    path.directory,
                    len(matched),
                    SCOPE_ERROR,
                )
                matched = matched[:SCOPE_ERROR]
            result.extend(matched)
        else:
            result.append(path)
    return result
