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

import itertools

import pytest

import mirage.core.gdrive.copy as copy_mod
import mirage.core.gdrive.mkdir as mkdir_mod
import mirage.core.gdrive.readdir as readdir_mod
import mirage.core.gdrive.rename as rename_mod
import mirage.core.gdrive.resolve as resolve_mod
import mirage.core.gdrive.rm as rm_mod
import mirage.core.gdrive.rmdir as rmdir_mod
import mirage.core.gdrive.stat as stat_mod
import mirage.core.gdrive.tree as tree_mod
import mirage.core.gdrive.truncate as truncate_mod
import mirage.core.gdrive.unlink as unlink_mod
import mirage.core.gdrive.write as write_mod
from mirage.accessor.gdrive import GDriveAccessor
from mirage.core.google._client import TokenManager
from mirage.core.google.config import GoogleConfig
from mirage.core.google.drive import FOLDER_MIME

FILE_MIME = "application/octet-stream"


class FakeDrive:
    """In-memory Drive: id-addressed items with parent links."""

    def __init__(self) -> None:
        self.items: dict[str, dict] = {}
        self._ids = itertools.count(1)

    def add(self,
            name: str,
            parent: str = "root",
            mime: str = FILE_MIME,
            content: bytes = b"",
            drive_id: str | None = None) -> str:
        item_id = f"id{next(self._ids)}"
        self.items[item_id] = {
            "id": item_id,
            "name": name,
            "mimeType": mime,
            "parents": [parent],
            "modifiedTime": "2026-01-01T00:00:00Z",
            "content": content,
        }
        if drive_id is not None:
            self.items[item_id]["driveId"] = drive_id
        return item_id

    def folder(self, name: str, parent: str = "root") -> str:
        return self.add(name, parent=parent, mime=FOLDER_MIME)

    def public(self, item_id: str) -> dict:
        item = self.items[item_id]
        out = {k: v for k, v in item.items() if k != "content"}
        out["size"] = str(len(item["content"]))
        return out

    async def list_files(self,
                         token_manager,
                         folder_id: str = "root",
                         drive_id: str | None = None,
                         mime_type: str | None = None,
                         trashed: bool = False,
                         page_size: int = 1000,
                         modified_after: str | None = None,
                         modified_before: str | None = None,
                         name: str | None = None) -> list[dict]:
        out = []
        for item in self.items.values():
            if folder_id not in item["parents"]:
                continue
            if name is not None and item["name"] != name:
                continue
            if mime_type and item["mimeType"] != mime_type:
                continue
            out.append(self.public(item["id"]))
        return out

    async def list_shared_drives(self,
                                 token_manager,
                                 page_size: int = 100) -> list[dict]:
        return []

    async def create_folder(self, token_manager, name: str,
                            parent_id: str) -> dict:
        return self.public(self.folder(name, parent=parent_id))

    async def upload_file(self,
                          token_manager,
                          name: str,
                          parent_id: str,
                          data: bytes,
                          mime_type: str = FILE_MIME) -> dict:
        return self.public(
            self.add(name, parent=parent_id, mime=mime_type, content=data))

    async def update_file_content(self,
                                  token_manager,
                                  file_id: str,
                                  data: bytes,
                                  mime_type: str = FILE_MIME) -> dict:
        self.items[file_id]["content"] = data
        return self.public(file_id)

    async def delete_file(self, token_manager, file_id: str) -> None:
        stack = [file_id]
        while stack:
            current = stack.pop()
            stack.extend(i["id"] for i in self.items.values()
                         if current in i["parents"])
            self.items.pop(current, None)

    async def patch_file(self,
                         token_manager,
                         file_id: str,
                         body: dict | None = None,
                         add_parents: str | None = None,
                         remove_parents: str | None = None) -> dict:
        item = self.items[file_id]
        if body:
            item.update(body)
        if add_parents:
            item["parents"].append(add_parents)
        if remove_parents:
            item["parents"].remove(remove_parents)
        return self.public(file_id)

    async def copy_file(self, token_manager, file_id: str, name: str,
                        parent_id: str) -> dict:
        src = self.items[file_id]
        return self.public(
            self.add(name,
                     parent=parent_id,
                     mime=src["mimeType"],
                     content=src["content"]))

    async def download_file(self, token_manager, file_id: str) -> bytes:
        return self.items[file_id]["content"]

    async def get_file(self, token_manager, file_id: str) -> dict:
        return self.public(file_id)

    def find(self, name: str) -> dict | None:
        for item in self.items.values():
            if item["name"] == name:
                return item
        return None


_PATCH_TARGETS = {
    resolve_mod: ("list_files", "list_shared_drives", "get_file"),
    readdir_mod: ("list_files", "list_shared_drives"),
    write_mod: ("update_file_content", "upload_file"),
    mkdir_mod: ("create_folder", ),
    unlink_mod: ("delete_file", ),
    rmdir_mod: ("delete_file", ),
    rm_mod: ("delete_file", ),
    rename_mod: ("delete_file", "list_files", "patch_file"),
    tree_mod: ("list_files", ),
    stat_mod: ("get_file", ),
    copy_mod: ("copy_file", "create_folder", "delete_file", "list_files"),
    truncate_mod: ("download_file", ),
}


@pytest.fixture
def fake_drive(monkeypatch):
    fake = FakeDrive()
    for mod, names in _PATCH_TARGETS.items():
        for fn_name in names:
            monkeypatch.setattr(mod, fn_name, getattr(fake, fn_name))
    return fake


@pytest.fixture
def gdrive_config():
    return GoogleConfig(
        client_id="test-id",
        client_secret="test-secret",
        refresh_token="test-refresh",
    )


@pytest.fixture
def gdrive_accessor(gdrive_config):
    manager = TokenManager(gdrive_config)
    manager._access_token = "fake-token"
    manager._expires_at = 9999999999
    return GDriveAccessor(config=gdrive_config, token_manager=manager)


def _scoped_gdrive_accessor(folder_id: str) -> GDriveAccessor:
    config = GoogleConfig(
        client_id="test-id",
        client_secret="test-secret",
        refresh_token="test-refresh",
        folder_id=folder_id,
    )
    manager = TokenManager(config)
    manager._access_token = "fake-token"
    manager._expires_at = 9999999999
    return GDriveAccessor(config=config, token_manager=manager)


@pytest.fixture
def scoped_accessor():
    return _scoped_gdrive_accessor
