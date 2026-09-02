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

from mirage.accessor.onedrive import OneDriveAccessor
from mirage.core.msgraph.drive_ops import identity_item
from mirage.core.onedrive.client import drive_loc, split_path
from mirage.ops.types import LiveFileIdentity
from mirage.types import PathSpec
from mirage.utils.errors import eisdir


async def live_identity(accessor: OneDriveAccessor,
                        path: PathSpec) -> LiveFileIdentity:
    """Bounded identity lookup: one plain item GET on the drive item.

    Args:
        accessor (OneDriveAccessor): backend accessor.
        path (PathSpec): the path to check.
    """
    virtual = path.virtual if isinstance(path, PathSpec) else path
    _, stripped = split_path(path)
    if not stripped:
        raise eisdir(virtual)
    return await identity_item(accessor.config,
                               drive_loc(accessor.config, stripped), virtual)
