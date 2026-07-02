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

from mirage.accessor.hf_buckets import HfBucketsAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.hf_buckets.constants import SCOPE_ERROR
from mirage.core.hf_buckets.readdir import readdir
from mirage.types import PathSpec
from mirage.utils.key_prefix import rekey

logger = logging.getLogger(__name__)


async def resolve_glob(
    accessor: HfBucketsAccessor,
    paths: list[PathSpec],
    index: IndexCacheStore,
) -> list[PathSpec]:
    result: list[PathSpec] = []
    for p in paths:
        if isinstance(p, str):
            result.append(
                PathSpec(resource_path=(p).strip("/"),
                         virtual=p,
                         directory=posixpath.dirname(p)))
            continue
        if p.resolved:
            result.append(p)
        elif p.pattern:
            entries = await readdir(accessor, p.dir, index)
            matched = [
                PathSpec.from_str_path(e, rekey(p.virtual, p.resource_path, e))
                for e in entries
                if fnmatch.fnmatch(e.rsplit("/", 1)[-1], p.pattern)
            ]
            if len(matched) > SCOPE_ERROR:
                logger.warning(
                    "%s: %d matches exceeds limit (%d), truncating",
                    p.directory,
                    len(matched),
                    SCOPE_ERROR,
                )
                matched = matched[:SCOPE_ERROR]
            result.extend(matched)
        else:
            result.append(p)
    return result
