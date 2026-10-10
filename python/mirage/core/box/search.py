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

import logging

from mirage.accessor.box import BoxAccessor
from mirage.core.box.api import search_content
from mirage.core.box.client import BoxApiError
from mirage.core.box.resolve import (
    mount_relative_key,
    path_parts,
    resolve_item,
    root_id,
)
from mirage.types import PathSpec

logger = logging.getLogger(__name__)


async def files_containing(
    accessor: BoxAccessor, text: str, under: list[PathSpec]
) -> set[str] | None:
    """Mount keys of the files under ``under`` Box content search returns.

    Each scope is searched with its folder id as ``ancestor_folder_ids``
    and each hit keyed from its ``path_collection``. None whenever the
    answer may miss a match: an API failure, the 10,000-match ceiling, a
    scope that no longer resolves to a folder, or no hit at all, since
    Box indexes a write some time after it lands.

    Args:
        accessor (BoxAccessor): backend handle.
        text (str): the whole word searched for.
        under (list[PathSpec]): the directories walked.
    """
    root = root_id(accessor)
    keys: set[str] = set()
    for p in under:
        parts = path_parts(p)
        if parts:
            item = await resolve_item(accessor, parts)
            if item is None or item.get("type") != "folder":
                return None
            folder_id = item["id"]
        else:
            folder_id = root
        try:
            results, truncated = await search_content(
                accessor.token_manager, text, folder_id
            )
        except BoxApiError as exc:
            logger.warning("box search failed (%s); reading every file", exc)
            return None
        if truncated:
            return None
        for item in results:
            key = mount_relative_key(item, root)
            if key:
                keys.add(key)
    return keys or None
