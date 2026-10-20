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
from mirage.core.gdrive.resolve import root_context
from mirage.core.gdrive.tree import PARENTS_PER_QUERY, iter_tree
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mounted_path

logger = logging.getLogger(__name__)


async def files_containing(
    accessor: GDriveAccessor,
    text: str,
    under: PathSpec,
    entry: FileStat | None,
) -> list[PathSpec] | None:
    """The files under ``under`` Drive full-text search names.

    The folder is walked by id and Drive is asked which files in the
    walked folders hold the text. None when a listing or the search
    fails or times out, nothing is found, Drive skips a corpus, or the
    scope is not a folder.

    Drive searches the text it extracted, not the bytes grep reads, so
    the answer can leave out a file that holds the text: a Docs, Sheets
    or Slides file (its JSON keys and ids), an office file, PDF or
    archive, the end of a large file, a word Drive splits differently
    (``foo.bar``), or a recent write.

    Args:
        accessor (GDriveAccessor): backend handle.
        text (str): the whole word searched for.
        under (PathSpec): the directory walked.
        entry (FileStat | None): what is at ``under``.
    """
    if not under.vfs_path.strip("/"):
        root, drive_id = await root_context(accessor)
    elif entry is None or entry.type is not FileType.DIRECTORY:
        return None
    else:
        root, drive_id = entry.extra["file_id"], entry.extra.get("drive_id")
    found: list[PathSpec] = []
    try:
        folders = [root]
        files: dict[str, list[PathSpec]] = {}
        async for rel, item, is_dir in iter_tree(
            accessor, under, root, drive_id
        ):
            if is_dir:
                folders.append(str(item["id"]))
            else:
                files.setdefault(str(item["id"]), []).append(
                    mounted_path(under, f"/{rel}")
                )
        drive = accessor.drive
        for start in range(0, len(folders), PARENTS_PER_QUERY):
            parents = folders[start : start + PARENTS_PER_QUERY]
            ids, complete = await drive.search_files(text, parents)
            if not complete:
                return None
            for file_id in ids:
                found.extend(files.get(file_id, []))
    except (OSError, aiohttp.ClientError) as exc:
        logger.debug("drive search failed (%s); reading every file", exc)
        return None
    return found or None
