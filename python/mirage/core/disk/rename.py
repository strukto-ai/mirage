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

import stat
from pathlib import Path

import aiofiles.os

from mirage.accessor.disk import DiskAccessor
from mirage.cache.context import invalidate_after_move
from mirage.core.disk.utils import resolve_inside
from mirage.types import PathSpec


async def _holds_subtree(path: Path) -> bool:
    """Whether a rename source may have anything cached beneath it.

    Only a regular file narrows the eviction. A directory relocates its
    subtree; anything else, or a source that is gone, keeps the subtree
    and leaves the rename to report its own error.

    Args:
        path (Path): the resolved source on the host.
    """
    try:
        info = await aiofiles.os.stat(path, follow_symlinks=False)
    except FileNotFoundError:
        return True
    return not stat.S_ISREG(info.st_mode)


async def rename(
    accessor: DiskAccessor, src_spec: PathSpec, dst_spec: PathSpec
) -> None:
    root = accessor.root
    src = await resolve_inside(root, src_spec)
    dst = await resolve_inside(root, dst_spec)
    # The kernel refuses a file over a directory and a directory over a
    # file, so the source's kind holds for both ends: a folder's subtree
    # is stale under both names, a file has nothing beneath either.
    # Classified before the rename, while the source is still there;
    # evicted after it, so a listing read in between cannot refill the
    # pre-rename view.
    folder = await _holds_subtree(src)
    await aiofiles.os.rename(src, dst)
    await invalidate_after_move(src_spec, folder)
    await invalidate_after_move(dst_spec, folder)
