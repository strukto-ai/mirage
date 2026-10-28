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

import asyncio
import logging
import os
import stat
from pathlib import Path

from mirage.accessor.disk import DiskAccessor
from mirage.core.disk.utils import resolve_inside, walk_entries
from mirage.types import PathSpec

logger = logging.getLogger(__name__)


def _bytes_under(host: Path) -> int:
    """The bytes of the regular files at or under ``host``; 0 for none.

    Args:
        host (Path): a checked host path.
    """
    try:
        info = os.lstat(host)
    except FileNotFoundError:
        return 0
    if not stat.S_ISDIR(info.st_mode):
        return info.st_size if stat.S_ISREG(info.st_mode) else 0
    total = 0
    for directory, _, names in walk_entries(host):
        for name in names:
            try:
                entry = os.lstat(directory / name)
            except FileNotFoundError:
                logger.debug("file vanished while counting: %s", name)
                continue
            if stat.S_ISREG(entry.st_mode):
                total += entry.st_size
    return total


async def size_of(accessor: DiskAccessor, path: PathSpec) -> int:
    """The bytes at ``path``, a directory's whole subtree included.

    Args:
        accessor (DiskAccessor): the mount's root.
        path (PathSpec): the operand.
    """
    host = await resolve_inside(accessor.root, path)
    return await asyncio.to_thread(_bytes_under, host)


async def count(accessor: DiskAccessor) -> int:
    """The bytes the whole mount root holds.

    Args:
        accessor (DiskAccessor): the mount's root.
    """
    return await asyncio.to_thread(_bytes_under, accessor.root)
