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
import posixpath
import stat
from pathlib import Path

from mirage.accessor.disk import DiskAccessor
from mirage.core.disk.errors import disk_errors
from mirage.core.disk.utils import exact_name, resolve_inside_sync
from mirage.observe.context import record, record_stream, start_op
from mirage.types import PathSpec
from mirage.utils.path import norm

logger = logging.getLogger(__name__)

# How a batch opens a file it checked: never through a link, and never
# waiting on a FIFO that replaced it since.
_OPEN_CHECKED = (
    os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
)


async def read(
    accessor: DiskAccessor,
    path_spec: PathSpec,
    offset: int = 0,
    size: int | None = None,
) -> bytes:
    """Read a file, or a byte range of it, seeking rather than reading
    the whole file.

    Args:
        accessor (DiskAccessor): the mount's disk handle.
        path_spec (PathSpec): the path to read.
        offset (int): first byte to read.
        size (int | None): how many bytes, or None for the rest.
    """
    virtual = path_spec.virtual
    root = accessor.root
    timer = start_op()

    def take() -> bytes:
        p = resolve_inside_sync(root, path_spec)
        with disk_errors(virtual):
            with open(p, "rb") as f:
                f.seek(offset)
                return f.read() if size is None else f.read(size)

    data = await asyncio.to_thread(take)
    record("read", virtual, "disk", len(data), timer)
    return data


async def read_many(
    accessor: DiskAccessor,
    paths: list[PathSpec],
    limit: int,
    room: int | None = None,
) -> dict[str, bytes]:
    """Several whole files in one trip off the event loop, by virtual
    path, each checked as its own read checks it (``resolve_inside_sync``):
    no link on the way and every name spelled as its entry is, each folder
    above the files proven once for the batch. A file is read only while
    it is the regular file its check saw; one longer than ``limit``, one
    that does not fit in ``room`` beside the files read before it, and
    one whose check or read fails is left out for its own read to meet.
    Each file read is recorded as a whole streamed read records it.

    Args:
        accessor (DiskAccessor): the mount's disk handle.
        paths (list[PathSpec]): the files, all on this mount.
        limit (int): the most bytes worth reading for one file.
        room (int | None): the most bytes the files read may come to
            together, None for no bound.
    """
    root = accessor.root

    def take() -> list[tuple[PathSpec, bytes]]:
        opened: set[str] = set()
        folders: dict[str, str | None] = {}
        out: list[tuple[PathSpec, bytes]] = []
        total = 0
        for spec in paths:
            folder, name = posixpath.split(norm(spec.mount_path))
            if folder not in folders:
                folders[folder] = _folder_inside(root, spec, folder, opened)
            parent = folders[folder]
            most = limit if room is None else min(limit, room - total)
            if parent is None or not name or most < 0:
                continue
            try:
                data = _read_checked(parent, name, most, opened)
            except OSError as exc:
                logger.debug(
                    "batch read leaves %s to its own read: %s",
                    spec.virtual,
                    exc,
                )
                continue
            if data is not None:
                total += len(data)
                out.append((spec, data))
        return out

    read: dict[str, bytes] = {}
    for spec, data in await asyncio.to_thread(take):
        rec = record_stream("read", spec.virtual, "disk")
        if rec is not None:
            rec.bytes = len(data)
            rec.complete = True
        read[spec.virtual] = data
    return read


def _folder_inside(
    root: Path, spec: PathSpec, folder: str, opened: set[str]
) -> str | None:
    """The host directory a batch's ``folder`` names, checked as a read of
    a file in it checks it, or None when it is no directory there.

    Args:
        root (Path): the mount root on the host.
        spec (PathSpec): a file in the folder, for the check's errors.
        folder (str): the folder, a mount-relative path.
        opened (set[str]): the parents the batch has proven readable.
    """
    try:
        host = resolve_inside_sync(root, spec, folder, opened)
        if stat.S_ISDIR(os.stat(host).st_mode):
            return str(host)
    except (OSError, ValueError) as exc:
        logger.debug("batch read leaves %s to its own read: %s", folder, exc)
    return None


def _read_checked(
    parent: str, name: str, most: int, opened: set[str]
) -> bytes | None:
    """The bytes of the regular file ``name`` in the checked host folder
    ``parent``, or None when it is no regular file spelled so, is longer
    than ``most`` bytes, or grew past its stat while it was read. The file
    is opened before its name is proven, so the proof is of the file that
    is read; a link refuses the open. One read asks for the size its stat
    gives and one byte more, never ``most``, so no buffer outgrows the
    file; a short read of a regular file is its end.

    Args:
        parent (str): the checked host folder.
        name (str): the file's name in it.
        most (int): the most bytes worth reading.
        opened (set[str]): the parents the batch has proven readable.
    """
    fd = os.open(os.path.join(parent, name), _OPEN_CHECKED)
    try:
        info = os.fstat(fd)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_size > most
            or not exact_name(parent, name, info, opened)
        ):
            return None
        data = os.read(fd, info.st_size + 1)
    finally:
        os.close(fd)
    return data if len(data) <= info.st_size else None
