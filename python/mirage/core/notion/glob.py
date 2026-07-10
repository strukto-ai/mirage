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

import dataclasses
import logging
import posixpath

from mirage.accessor.notion import NotionAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.constants import SCOPE_ERROR
from mirage.core.notion.readdir import readdir
from mirage.types import PathSpec
from mirage.utils.glob_walk import expand_pattern, is_word_shaped

logger = logging.getLogger(__name__)


async def resolve_glob(
    accessor: NotionAccessor,
    paths: list[PathSpec],
    index: IndexCacheStore,
    prefix: str = "",
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
            matched = await expand_pattern(readdir, accessor, p, index)
            if not matched and is_word_shaped(p):
                # bash nullglob off: an unmatched glob word stays literal
                result.append(
                    dataclasses.replace(p, pattern=None, resolved=True))
                continue
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
