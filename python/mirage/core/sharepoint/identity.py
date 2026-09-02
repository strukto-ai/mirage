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

from mirage.accessor.sharepoint import SharePointAccessor
from mirage.core.msgraph.drive_ops import identity_item
from mirage.core.sharepoint.client import split_path
from mirage.core.sharepoint.resolve import drive_loc, resolve
from mirage.ops.types import LiveFileIdentity
from mirage.types import PathSpec
from mirage.utils.errors import eisdir, enoent


async def live_identity(accessor: SharePointAccessor,
                        path: PathSpec) -> LiveFileIdentity:
    """Bounded identity lookup: resolve to a drive item, then one GET.

    The resolve is ``fresh``: the site and drive name->id memos never
    expire, so a drive deleted and recreated under the same name would
    otherwise be addressed by an id that is gone, and the item GET
    against it would answer 404 -- reported as ``exists=False`` for a
    file that is there. That costs the site and drive listings on every
    call (two requests for an unscoped mount, none more), which is the
    price of a live answer and is bounded by the namespace depth rather
    than by the tree.

    A missing site or a missing drive is absence, not ENOENT: the
    contract makes absence a value a caller branches on, and which
    component of the path went missing is not something that caller
    should have to handle two ways. EISDIR stays for a site or drive
    that *does* resolve, because that path names a directory.

    Args:
        accessor (SharePointAccessor): backend accessor.
        path (PathSpec): the path to check.
    """
    virtual = path.virtual if isinstance(path, PathSpec) else path
    _, stripped = split_path(path)
    if not stripped:
        raise eisdir(virtual)

    resolved = await resolve(accessor, path, fresh=True)

    if resolved.level == "site":
        if resolved.site_id is None:
            return LiveFileIdentity(exists=False,
                                    revision=None,
                                    fingerprint=None)
        raise eisdir(virtual)

    if resolved.level == "drive":
        if resolved.drive_id is None:
            return LiveFileIdentity(exists=False,
                                    revision=None,
                                    fingerprint=None)
        raise eisdir(virtual)

    if resolved.drive_id is None or resolved.item_path is None:
        raise enoent(virtual)

    return await identity_item(accessor.config,
                               drive_loc(accessor.config, resolved, stripped),
                               virtual)
