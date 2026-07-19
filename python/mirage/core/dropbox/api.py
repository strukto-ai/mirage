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

from mirage.core.dropbox._client import DropboxTokenManager, dropbox_rpc


async def get_metadata(tm: DropboxTokenManager, path: str) -> dict[str, Any]:
    return await dropbox_rpc(tm, "/files/get_metadata", {"path": path})


async def create_folder(tm: DropboxTokenManager, path: str) -> None:
    await dropbox_rpc(tm, "/files/create_folder_v2", {
        "path": path,
        "autorename": False,
    })


async def delete_path(tm: DropboxTokenManager, path: str) -> None:
    await dropbox_rpc(tm, "/files/delete_v2", {"path": path})


async def move_path(tm: DropboxTokenManager, from_path: str,
                    to_path: str) -> None:
    await dropbox_rpc(tm, "/files/move_v2", {
        "from_path": from_path,
        "to_path": to_path,
        "autorename": False,
    })


async def copy_path(tm: DropboxTokenManager, from_path: str,
                    to_path: str) -> None:
    await dropbox_rpc(tm, "/files/copy_v2", {
        "from_path": from_path,
        "to_path": to_path,
        "autorename": False,
    })


async def list_folder(
    tm: DropboxTokenManager,
    path: str,
    recursive: bool = False,
    limit: int = 2000,
) -> list[dict[str, Any]]:
    api_path = "" if path in ("/", "") else path
    out: list[dict[str, Any]] = []
    resp = await dropbox_rpc(tm, "/files/list_folder", {
        "path": api_path,
        "recursive": recursive,
        "limit": limit,
    })
    out.extend(resp["entries"])
    while resp.get("has_more"):
        resp = await dropbox_rpc(tm, "/files/list_folder/continue",
                                 {"cursor": resp["cursor"]})
        out.extend(resp["entries"])
    return out
