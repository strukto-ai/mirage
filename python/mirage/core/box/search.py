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
from mirage.core.box.resolve import mount_relative_key, path_parts, root_id
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mounted_path

logger = logging.getLogger(__name__)


async def files_containing(
    accessor: BoxAccessor,
    text: str,
    under: PathSpec,
    entry: FileStat | None = None,
) -> list[PathSpec] | None:
    """The files under ``under`` Box content search returns.

    The scope is searched with its folder id as ``ancestor_folder_ids``
    and each hit keyed from its ``path_collection``. None whenever the
    answer may miss a match: an API failure, the 10,000-match ceiling, a
    scope that is not a folder, or no hit at all, since Box indexes a
    write some time after it lands.

    Box searches the text it extracted, not the bytes grep reads, so
    the answer can leave out a file that holds the text: an office file,
    PDF or archive, the end of a large file, a word Box splits
    differently (``foo.bar``), or a recent write.

    Args:
        accessor (BoxAccessor): backend handle.
        text (str): the whole word searched for.
        under (PathSpec): the directory walked.
        entry (FileStat | None): what is at ``under``.
    """
    root = root_id(accessor)
    if not path_parts(under):
        folder_id = root
    elif entry is None or entry.type is not FileType.DIRECTORY:
        return None
    else:
        folder_id = entry.extra["box_id"]
    try:
        results, truncated = await search_content(
            accessor.token_manager, text, folder_id
        )
    except BoxApiError as exc:
        logger.debug("box search failed (%s); reading every file", exc)
        return None
    if truncated:
        return None
    found: list[PathSpec] = []
    for item in results:
        key = mount_relative_key(item, root)
        if key:
            found.append(mounted_path(under, "/" + key))
    return found or None
