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
from collections.abc import Awaitable, Callable

from qdrant_client.http.exceptions import ApiException

from mirage.accessor.qdrant import QdrantAccessor
from mirage.core.hierarchy.probe import rows_of
from mirage.core.qdrant.naming import group_name, row_stem
from mirage.core.qdrant.payload import field_value
from mirage.core.qdrant.render import render_json, render_text
from mirage.core.vector.types import Row
from mirage.types import DirListing, FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mounted_path

logger = logging.getLogger(__name__)


def hit(accessor: QdrantAccessor, row: Row) -> tuple[list[str], bytes]:
    """A ranked point's path below its collection, and its body.

    The source text when the point has one, its ``.json`` otherwise.

    Args:
        accessor (QdrantAccessor): the mount's accessor.
        row (Row): the ranked point.
    """
    config = accessor.config
    segments = [
        group_name(value, basename=column in config.basename_fields)
        for column in config.group_by
        if (value := field_value(row, column)) is not None
    ]
    stem = row_stem(row, config)
    if config.text_field and field_value(row, config.text_field) is not None:
        return segments + [f"{stem}.txt"], render_text(row, config)
    return segments + [f"{stem}.json"], render_json(row, config)


async def files_containing(
    readdir: Callable[
        [QdrantAccessor, PathSpec], Awaitable[list[FileStat] | DirListing]
    ],
    accessor: QdrantAccessor,
    text: str,
    under: list[PathSpec],
) -> list[PathSpec] | None:
    """The files under ``under`` that may hold ``text`` in any case.

    The listing's scroll carries every payload, so each ``.json`` and
    ``.txt`` row keeps its rendered text, lowercased, and a file is read
    only when that text holds ``text``; a blob, or a file too large to
    keep, is always read. The walk lists each directory from the store,
    so the text is checked against the points as they are now. None for
    a text that is not ASCII, whose case a lowercased copy may not keep,
    or a listing that fails.

    Args:
        readdir (Callable): the mount's readdir.
        accessor (QdrantAccessor): the mount's accessor.
        text (str): plain text every match holds.
        under (list[PathSpec]): the directories walked.
    """
    if not text.isascii():
        return None
    try:
        return await _found(readdir, accessor, text.lower(), under)
    except (ApiException, OSError) as exc:
        logger.debug("qdrant listing failed (%s); reading every file", exc)
        return None


async def _found(
    readdir: Callable[
        [QdrantAccessor, PathSpec], Awaitable[list[FileStat] | DirListing]
    ],
    accessor: QdrantAccessor,
    needle: str,
    under: list[PathSpec],
) -> list[PathSpec]:
    found: list[PathSpec] = []
    pending = list(under)
    while pending:
        current = pending.pop()
        parent = current.mount_path.rstrip("/")
        for row in rows_of(await readdir(accessor, current)):
            child = mounted_path(current, f"{parent}/{row.name}")
            if row.type is FileType.DIRECTORY:
                pending.append(child)
                continue
            kept = row.extra.get("text")
            if isinstance(kept, str) and needle not in kept:
                continue
            found.append(child)
    return found
