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
from mirage.cache.context import (invalidate_after_unlink,
                                  invalidate_after_write)
from mirage.core.msgraph.drive_ops import rename_replace
from mirage.core.onedrive._client import drive_loc, split_path
from mirage.types import PathSpec


async def rename(accessor: OneDriveAccessor, src: PathSpec,
                 dst: PathSpec) -> None:
    _, src_s = split_path(src)
    _, dst_s = split_path(dst)
    config = accessor.config
    await rename_replace(config, drive_loc(config, src_s),
                         drive_loc(config, dst_s))
    await invalidate_after_write(dst)
    await invalidate_after_unlink(src)
