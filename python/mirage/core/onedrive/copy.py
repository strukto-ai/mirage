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

from functools import partial

from mirage.accessor.onedrive import OneDriveAccessor, OneDriveConfig
from mirage.core.msgraph.drive_ops import DriveLoc, copy_tree
from mirage.core.onedrive._client import drive_ref_path, item_url, split_path
from mirage.types import PathSpec


def drive_loc(config: OneDriveConfig, stripped: str) -> DriveLoc:
    return DriveLoc(drive="",
                    path=stripped,
                    virt=stripped,
                    url=partial(item_url, config),
                    ref=partial(drive_ref_path, config))


async def copy(accessor: OneDriveAccessor, src: PathSpec,
               dst: PathSpec) -> None:
    _, src_s = split_path(src)
    _, dst_s = split_path(dst)
    config = accessor.config
    await copy_tree(config, drive_loc(config, src_s), drive_loc(config, dst_s))
