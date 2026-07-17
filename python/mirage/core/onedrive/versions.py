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
from mirage.core.msgraph.drive_ops import capture_item_metadata
from mirage.core.onedrive._client import drive_loc, graph_list, split_path
from mirage.types import PathSpec


async def list_versions(accessor: OneDriveAccessor,
                        path: PathSpec) -> list[dict]:
    _, stripped = split_path(path)
    loc = drive_loc(accessor.config, stripped)
    return await graph_list(accessor.config, loc.item("/versions"))


async def capture_metadata(
        accessor: OneDriveAccessor,
        path: PathSpec) -> tuple[str | None, str | None, str | None]:
    _, stripped = split_path(path)
    return await capture_item_metadata(accessor.config,
                                       drive_loc(accessor.config, stripped))
