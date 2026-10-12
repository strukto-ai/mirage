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
from typing import TypeVar
from urllib.parse import quote

import aiohttp

from mirage.accessor.base import Accessor
from mirage.cache.index import IndexCacheStore, IndexEntry, ResourceType
from mirage.core.api.client import SessionArg
from mirage.core.hierarchy.probe import ReaddirFn, entries_under
from mirage.core.msgraph.client import GraphError, graph_list
from mirage.core.msgraph.config import MsGraphConfig
from mirage.core.msgraph.drive import DriveLoc
from mirage.types import PathSpec

logger = logging.getLogger(__name__)

A = TypeVar("A", bound=Accessor)


def _is_folder(entry: IndexEntry) -> bool:
    return entry.resource_type == ResourceType.FOLDER


async def files_containing(
    config: MsGraphConfig,
    readdir: ReaddirFn[A],
    accessor: A,
    scopes: list[tuple[PathSpec, DriveLoc]],
    text: str,
    index: IndexCacheStore,
    session: SessionArg = None,
) -> list[PathSpec] | None:
    """The files under each scope Graph search names.

    Each scope is walked through the index (the listings grep reads
    next) and searched from its folder; a hit counts when its id is a
    walked file. None when a listing or the search fails or times out,
    nothing is found, or a walked file has no id.

    Graph searches the text it extracted, not the bytes grep reads, so
    the answer can leave out a file that holds the text: an office file,
    PDF or archive, the end of a large file, a word Graph splits
    differently (``foo.bar``), or a recent write.

    Args:
        config (MsGraphConfig): Graph config.
        readdir (ReaddirFn): the backend's readdir.
        accessor (Accessor): backend accessor.
        scopes (list[tuple[PathSpec, DriveLoc]]): each directory walked,
            with the drive item it searches from.
        text (str): the whole word searched for.
        index (IndexCacheStore): the mount's index.
        session (SessionArg): pool or live session to ride.
    """
    quoted = quote(text.replace("'", "''"), safe="!*'()")
    found: list[PathSpec] = []
    try:
        for directory, loc in scopes:
            walked = await entries_under(
                readdir, accessor, directory, index, _is_folder
            )
            if walked is None:
                return None
            files: dict[str, list[PathSpec]] = {}
            for path, entry in walked:
                if _is_folder(entry):
                    continue
                if not entry.extra.get("id"):
                    return None
                files.setdefault(entry.extra["id"], []).append(path)
            items = await graph_list(
                config,
                loc.item(f"/search(q='{quoted}')"),
                params={"$select": "id"},
                session=session,
            )
            for item in items:
                found.extend(files.get(item.get("id", ""), []))
    except (OSError, aiohttp.ClientError, GraphError) as exc:
        logger.debug("graph search failed (%s); reading every file", exc)
        return None
    return found or None
