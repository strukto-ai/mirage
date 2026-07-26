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

from mirage.resource.redis.store import RedisStore
from mirage.types import PathSpec
from mirage.utils.errors import enoent, enotdir
from mirage.utils.path import ancestors


async def check_dest_parents(store: RedisStore, dst_spec: PathSpec,
                             d: str) -> None:
    """Reject a destination whose parent chain is not all directories.

    Mirrors how ``rename(2)`` resolves the destination: a component that
    does not exist is ENOENT, a component that is a plain file is ENOTDIR
    (at any depth). Without this the store grows a key under a directory
    it never recorded, and that orphan makes both the phantom directory
    and its real parent unlistable.

    Shared by every op that places a key at a caller-supplied path
    (``rename``, ``copy``, ``create``, ``write_bytes``, ``append_bytes``,
    ``mkdir``): none of them creates parents (that is ``mkdir -p``), so all
    owe the destination the same probe. The real-filesystem backends get
    this from the kernel.

    Components are probed one at a time rather than by pulling the whole
    directory set: this runs on every write, so a set membership test per
    component (O(1), and a path is only a few components deep) beats
    transferring every directory in the mount.

    Args:
        store (RedisStore): The backing store.
        dst_spec (PathSpec): Destination operand, reported in the error.
        d (str): Normalized destination key.

    Raises:
        NotADirectoryError: A parent component is a plain file.
        FileNotFoundError: A parent component does not exist.
    """
    for ancestor in ancestors(d):
        if await store.has_dir(ancestor):
            continue
        if await store.has_file(ancestor):
            raise enotdir(dst_spec)
        raise enoent(dst_spec)
