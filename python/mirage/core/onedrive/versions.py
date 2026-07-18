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

from typing import Any

from mirage.accessor.onedrive import OneDriveAccessor
from mirage.core.onedrive._client import drive_loc, graph_list, split_path
from mirage.types import PathSpec


async def list_versions(accessor: OneDriveAccessor,
                        path: PathSpec) -> list[dict[str, Any]]:
    _, stripped = split_path(path)
    loc = drive_loc(accessor.config, stripped)
    return await graph_list(accessor.config, loc.item("/versions"))
