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
from mirage.core.onedrive._client import (graph_get, graph_list, item_url,
                                          split_path)
from mirage.types import PathSpec


def _current_version_id(versions: list[dict]) -> str | None:
    if not versions:
        return None
    current = max(versions, key=lambda v: v.get("lastModifiedDateTime") or "")
    return current.get("id")


async def list_versions(accessor: OneDriveAccessor,
                        path: PathSpec) -> list[dict]:
    _, stripped = split_path(path)
    url = item_url(accessor.config, "/" + stripped, action="/versions")
    return await graph_list(accessor.config, url)


async def capture_metadata(
        accessor: OneDriveAccessor,
        path: PathSpec) -> tuple[str | None, str | None, str | None]:
    _, stripped = split_path(path)
    config = accessor.config
    item = await graph_get(config,
                           item_url(config, "/" + stripped),
                           params={"$expand": "versions"})
    fingerprint = item.get("cTag")
    revision = _current_version_id(item.get("versions", []))
    download_url = item.get("@microsoft.graph.downloadUrl")
    return fingerprint, revision, download_url
