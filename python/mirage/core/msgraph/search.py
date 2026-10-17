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
from urllib.parse import quote

import aiohttp

from mirage.accessor.onedrive import OneDriveAccessor
from mirage.accessor.sharepoint import SharePointAccessor
from mirage.core.msgraph.client import GraphError, graph_list
from mirage.core.msgraph.drive import DriveLoc, iter_tree
from mirage.types import PathSpec
from mirage.utils.key_prefix import mounted_path

logger = logging.getLogger(__name__)


async def files_containing(
    accessor: OneDriveAccessor | SharePointAccessor,
    scopes: list[tuple[PathSpec, DriveLoc]],
    text: str,
) -> list[PathSpec] | None:
    """The files under each scope Graph search names.

    Each scope is walked and searched from its folder; a hit counts when
    its id is a walked file. None when a listing or the search fails or
    times out, nothing is found, or a walked file has no id.

    Graph searches the text it extracted, not the bytes grep reads, so
    the answer can leave out a file that holds the text: an office file,
    PDF or archive, the end of a large file, a word Graph splits
    differently (``foo.bar``), or a recent write.

    Args:
        accessor (OneDriveAccessor | SharePointAccessor): Graph accessor.
        scopes (list[tuple[PathSpec, DriveLoc]]): each directory walked,
            with the drive item it searches from.
        text (str): the whole word searched for.
    """
    quoted = quote(text.replace("'", "''"), safe="!*'()")
    found: list[PathSpec] = []
    try:
        for directory, loc in scopes:
            files: dict[str, list[PathSpec]] = {}
            async for virt, item, is_dir in iter_tree(accessor, loc):
                if is_dir:
                    continue
                if not item.get("id"):
                    return None
                files.setdefault(item["id"], []).append(
                    mounted_path(directory, f"/{virt}")
                )
            items = await graph_list(
                accessor,
                loc.item(f"/search(q='{quoted}')"),
                params={"$select": "id"},
            )
            for item in items:
                found.extend(files.get(item.get("id", ""), []))
    except (OSError, aiohttp.ClientError, GraphError) as exc:
        logger.debug("graph search failed (%s); reading every file", exc)
        return None
    return found or None
