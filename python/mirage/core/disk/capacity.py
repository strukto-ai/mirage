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
from mirage.core.disk.utils import resolve_inside
from mirage.types import PathSpec

logger = logging.getLogger(__name__)


def _bytes_under(host: Path) -> int:
    """The bytes of the regular files at or under ``host``; 0 for none.

    Args:
        host (Path): a checked host path.
    """
    try:
        info = os.lstat(host)
    except (FileNotFoundError, PermissionError) as exc:
        logger.debug("path skipped while counting %s: %s", host, exc)
        return 0
    if not stat.S_ISDIR(info.st_mode):
        return info.st_size if stat.S_ISREG(info.st_mode) else 0

    def skipped(exc: OSError) -> None:
        if not isinstance(exc, (FileNotFoundError, PermissionError)):
            raise exc
        logger.debug("directory skipped while counting %s: %s", host, exc)

    total = 0
    for directory, _, names in os.walk(host, onerror=skipped):
        for name in names:
            try:
                entry = os.lstat(Path(directory) / name)
            except (FileNotFoundError, PermissionError) as exc:
                logger.debug("file skipped while counting %s: %s", name, exc)
                continue
            if stat.S_ISREG(entry.st_mode):
                total += entry.st_size
    return total


async def is_counted(accessor: DiskAccessor, path: PathSpec) -> bool:
    """Whether whole-root counting can traverse the operand's ancestors.

    Args:
        accessor (DiskAccessor): the mount's root.
        path (PathSpec): the operand.
    """
    try:
        host = await resolve_inside(accessor.root, path)
    except PermissionError as exc:
        logger.debug(
            "ancestor skipped while counting %s: %s", path.virtual, exc
        )
        return False
    root = Path(os.path.abspath(accessor.root))

    def included() -> bool:
        if host != root:
            for directory in host.parents:
                try:
                    with os.scandir(directory):
                        pass
                except (FileNotFoundError, PermissionError) as exc:
                    logger.debug(
                        "ancestor skipped while counting %s: %s",
                        directory,
                        exc,
                    )
                    return False
                if directory == root:
                    break
        return True

    return await asyncio.to_thread(included)


async def size_of(
    accessor: DiskAccessor, path: PathSpec, *, accounted: bool = True
) -> int:
    """Measure bytes for accounting or for reserving a transfer.

    Args:
        accessor (DiskAccessor): the mount's root.
        path (PathSpec): the operand.
        accounted (bool): exclude paths whose ancestors cannot be listed;
            False measures a source's bytes before copying or moving it.
    """
    if accounted and not await is_counted(accessor, path):
        return 0
    host = await resolve_inside(accessor.root, path)
    return await asyncio.to_thread(_bytes_under, host)


async def count(accessor: DiskAccessor) -> int:
    """The bytes the whole mount root holds.

    Args:
        accessor (DiskAccessor): the mount's root.
    """
    return await asyncio.to_thread(_bytes_under, accessor.root)
