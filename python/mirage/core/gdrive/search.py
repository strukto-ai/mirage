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

import aiohttp

from mirage.accessor.gdrive import GDriveAccessor
from mirage.cache.index import IndexCacheStore, IndexEntry
from mirage.core.gdrive import DIRECTORY_RESOURCE_TYPES
from mirage.core.gdrive.readdir import readdir
from mirage.core.gdrive.resolve import root_context
from mirage.core.google.drive import search_files
from mirage.core.hierarchy.probe import entries_under, resolve_entry
from mirage.types import PathSpec

logger = logging.getLogger(__name__)

PARENTS_PER_QUERY = 40


def _is_folder(entry: IndexEntry) -> bool:
    return entry.resource_type in DIRECTORY_RESOURCE_TYPES


async def _folder_id(
    accessor: GDriveAccessor, directory: PathSpec, index: IndexCacheStore
) -> str | None:
    if not directory.vfs_path.strip("/"):
        folder_id, _ = await root_context(accessor)
        return folder_id
    entry = await resolve_entry(readdir, accessor, directory, index)
    if entry is None or not _is_folder(entry):
        return None
    return entry.id


async def files_containing(
    accessor: GDriveAccessor,
    text: str,
    under: list[PathSpec],
    index: IndexCacheStore,
) -> list[PathSpec] | None:
    """The files under ``under`` Drive full-text search names.

    Each scope is walked through the index (the listings grep reads
    next) and Drive is asked which files in the walked folders hold the
    text. None when a listing or the search fails or times out, nothing
    is found, Drive skips a corpus, or a scope is not a folder.

    Drive searches the text it extracted, not the bytes grep reads, so
    the answer can leave out a file that holds the text: a Docs, Sheets
    or Slides file (its JSON keys and ids), an office file, PDF or
    archive, the end of a large file, a word Drive splits differently
    (``foo.bar``), or a recent write.

    Args:
        accessor (GDriveAccessor): backend handle.
        text (str): the whole word searched for.
        under (list[PathSpec]): the directories walked.
        index (IndexCacheStore): the mount's index.
    """
    found: list[PathSpec] = []
    try:
        for directory in under:
            root = await _folder_id(accessor, directory, index)
            walked = await entries_under(
                readdir, accessor, directory, index, _is_folder
            )
            if root is None or walked is None:
                return None
            folders = [root]
            files: dict[str, list[PathSpec]] = {}
            for path, entry in walked:
                if _is_folder(entry):
                    folders.append(entry.id)
                else:
                    files.setdefault(entry.id, []).append(path)
            for start in range(0, len(folders), PARENTS_PER_QUERY):
                parents = folders[start : start + PARENTS_PER_QUERY]
                ids, complete = await search_files(
                    accessor.token_manager, text, parents
                )
                if not complete:
                    return None
                for file_id in ids:
                    found.extend(files.get(file_id, []))
    except (OSError, aiohttp.ClientError) as exc:
        logger.debug("drive search failed (%s); reading every file", exc)
        return None
    return found or None
