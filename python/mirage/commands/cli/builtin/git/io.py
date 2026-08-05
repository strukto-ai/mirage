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
import posixpath
from typing import Any, Callable

from mirage.types import PathSpec
from mirage.utils.errors import MISS_ERRORS

logger = logging.getLogger(__name__)


async def read_file(dispatch: Callable[..., Any], path: str) -> bytes:
    """Read one virtual path through the workspace dispatcher.

    Args:
        dispatch (Callable): workspace op dispatcher.
        path (str): absolute virtual path.
    """
    data, _ = await dispatch("read", PathSpec.from_str_path(path))
    return data if isinstance(data, bytes) else bytes(data)


async def read_range(dispatch: Callable[..., Any], path: str, offset: int,
                     size: int) -> bytes:
    """Read a byte range of one virtual path.

    Args:
        dispatch (Callable): workspace op dispatcher.
        path (str): absolute virtual path.
        offset (int): first byte to read.
        size (int): how many bytes to read.
    """
    data, _ = await dispatch("read",
                             PathSpec.from_str_path(path),
                             offset=offset,
                             size=size)
    return data if isinstance(data, bytes) else bytes(data)


async def file_size(dispatch: Callable[..., Any], path: str) -> int | None:
    """A path's byte length, or None when the backend does not know it.

    Args:
        dispatch (Callable): workspace op dispatcher.
        path (str): absolute virtual path.
    """
    stat, _ = await dispatch("stat", PathSpec.from_str_path(path))
    return getattr(stat, "size", None)


async def read_optional(dispatch: Callable[..., Any],
                        path: str) -> bytes | None:
    """Read a path that a repository may legitimately not have.

    ``packed-refs`` and ``HEAD``-adjacent files are absent in perfectly
    valid repositories, so a miss is an answer rather than an error.

    Args:
        dispatch (Callable): workspace op dispatcher.
        path (str): absolute virtual path.
    """
    try:
        return await read_file(dispatch, path)
    except MISS_ERRORS:
        return None


async def read_names(dispatch: Callable[..., Any], path: str) -> list[str]:
    """List a directory, empty when it does not exist.

    Args:
        dispatch (Callable): workspace op dispatcher.
        path (str): absolute virtual path of the directory.
    """
    try:
        entries, _ = await dispatch("readdir", PathSpec.from_str_path(path))
    except MISS_ERRORS:
        return []
    return list(entries or [])


async def ensure_dir(dispatch: Callable[..., Any], path: str) -> None:
    """Create a directory and every missing directory above it.

    Written out rather than delegated to ``mkdir -p`` because the
    parents flag is a per-backend capability: the ops factory only wires
    ``parents=True`` for backends that declare it, so a plain ``mkdir``
    of ``objects/ab`` fails on the rest.

    Existence is probed with a point stat, which on a prefix store misses
    a directory that has no object of its own. That false negative is
    harmless here and the reason this does not need the two-channel
    stat: on such a store a directory is the set of keys under it, so
    creating one again costs a no-op rather than an error.

    Args:
        dispatch (Callable): workspace op dispatcher.
        path (str): absolute virtual path of the directory.
    """
    missing: list[str] = []
    current = path.rstrip("/")
    while current and current != "/":
        try:
            await dispatch("stat", PathSpec.from_str_path(current))
            break
        except MISS_ERRORS:
            missing.append(current)
            current = posixpath.dirname(current)
    for target in reversed(missing):
        await dispatch("mkdir", PathSpec.from_str_path(target))


async def exists(dispatch: Callable[..., Any], path: str) -> bool:
    """Whether a point lookup finds anything at a path.

    Args:
        dispatch (Callable): workspace op dispatcher.
        path (str): absolute virtual path.
    """
    try:
        await dispatch("stat", PathSpec.from_str_path(path))
    except MISS_ERRORS:
        return False
    return True


async def write_file(dispatch: Callable[..., Any], path: str,
                     data: bytes) -> None:
    """Write one virtual path, creating the directories above it.

    Args:
        dispatch (Callable): workspace op dispatcher.
        path (str): absolute virtual path.
        data (bytes): the whole contents.
    """
    await ensure_dir(dispatch, posixpath.dirname(path))
    await dispatch("write", PathSpec.from_str_path(path), data=data)


async def write_once(dispatch: Callable[..., Any], path: str,
                     data: bytes) -> None:
    """Write a path only if nothing is there yet.

    For content-addressed files, which is every object in the database:
    a path that exists already holds exactly these bytes, because its
    name is a hash of them. Skipping the write is therefore not an
    optimisation but a requirement, since git writes loose objects
    read-only (0444) and rewriting one fails with EACCES. Re-staging an
    unchanged file hits that on the first try.

    Args:
        dispatch (Callable): workspace op dispatcher.
        path (str): absolute virtual path.
        data (bytes): the whole contents.
    """
    if await exists(dispatch, path):
        return
    await write_file(dispatch, path, data)


async def remove_file(dispatch: Callable[..., Any], path: str) -> None:
    """Delete one virtual path, tolerating one that is already gone.

    A miss is an answer rather than an error for every caller here:
    unstaging a path deletes whatever ref or lock may or may not exist,
    and a checkout removes files the other branch does not have.

    Args:
        dispatch (Callable): workspace op dispatcher.
        path (str): absolute virtual path.
    """
    try:
        await dispatch("unlink", PathSpec.from_str_path(path))
    except MISS_ERRORS as exc:
        logger.debug("nothing to remove at %s: %s", path, exc)
