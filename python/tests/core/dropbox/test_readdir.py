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

from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.dropbox import DropboxAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.dropbox.client import DropboxApiError, DropboxTokenManager
from mirage.core.dropbox.readdir import readdir
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.dropbox.config import DropboxConfig


def make_accessor(root_path: str = "/") -> DropboxAccessor:
    config = DropboxConfig(client_id="c",
                           client_secret="s",
                           refresh_token="r",
                           root_path=root_path)
    return DropboxAccessor(config, DropboxTokenManager(config))


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.mark.asyncio
async def test_readdir_root_marks_folders_with_slash(index):
    files = [
        {
            ".tag": "folder",
            "id": "id:folder1",
            "name": "docs",
            "path_display": "/docs",
        },
        {
            ".tag": "file",
            "id": "id:file1",
            "name": "notes.txt",
            "path_display": "/notes.txt",
            "size": 42,
            "server_modified": "2026-04-01T00:00:00Z",
        },
    ]
    with patch("mirage.core.dropbox.readdir.list_folder",
               new_callable=AsyncMock,
               return_value=files) as fake:
        out = await readdir(make_accessor(),
                            PathSpec(vfs_path="", virtual="/", directory="/"),
                            index)
    assert out == ["/docs/", "/notes.txt"]
    assert fake.await_args.args[1] == ""


@pytest.mark.asyncio
async def test_readdir_scopes_under_subfolder_root(index):

    async def fake_list(tm, path):
        if path == "/Team/data":
            return [{
                ".tag": "folder",
                "id": "id:docs",
                "name": "docs",
                "path_display": "/Team/data/docs",
            }]
        if path == "/Team/data/docs":
            return [{
                ".tag": "file",
                "id": "id:n1",
                "name": "note.md",
                "path_display": "/Team/data/docs/note.md",
                "size": 12,
            }]
        raise AssertionError(f"unexpected path={path}")

    accessor = make_accessor("/Team/data")
    with patch("mirage.core.dropbox.readdir.list_folder",
               side_effect=fake_list):
        root = await readdir(accessor,
                             PathSpec(vfs_path="", virtual="/", directory="/"),
                             index)
        nested = await readdir(
            accessor,
            PathSpec(vfs_path="docs", virtual="/docs", directory="/docs"),
            index)
    assert root == ["/docs/"]
    assert nested == ["/docs/note.md"]


@pytest.mark.asyncio
async def test_readdir_honors_mount_prefix(index):
    files = [{
        ".tag": "file",
        "id": "id:f",
        "name": "a.txt",
        "path_display": "/a.txt",
        "size": 1,
    }]
    with patch("mirage.core.dropbox.readdir.list_folder",
               new_callable=AsyncMock,
               return_value=files):
        out = await readdir(
            make_accessor(),
            PathSpec(virtual="/dropbox",
                     directory="/dropbox",
                     vfs_path=mount_key("/dropbox", "/dropbox")), index)
    assert out == ["/dropbox/a.txt"]


def _metadata(entries: dict[str, str]):

    async def fake(_tm, path: str):
        tag = entries.get(path)
        if tag is None:
            raise DropboxApiError("path/not_found", 409)
        return {".tag": tag, "name": path.rsplit("/", 1)[-1]}

    return fake


@pytest.mark.asyncio
async def test_readdir_maps_409_to_enoent(index):
    with patch("mirage.core.dropbox.readdir.list_folder",
               new_callable=AsyncMock,
               side_effect=DropboxApiError("not found", 409)):
        with patch("mirage.core.dropbox.readdir.get_metadata",
                   new=_metadata({})):
            with pytest.raises(FileNotFoundError):
                await readdir(
                    make_accessor(),
                    PathSpec(vfs_path="missing",
                             virtual="/missing",
                             directory="/missing"), index)


@pytest.mark.asyncio
async def test_readdir_under_a_file_is_enotdir(index):
    # list_folder answers path/not_found for `/a.txt/x` exactly as it does
    # for a name that is simply absent, so only the ancestor walk can tell
    # GNU's "Not a directory" from "No such file or directory".
    with patch("mirage.core.dropbox.readdir.list_folder",
               new_callable=AsyncMock,
               side_effect=DropboxApiError("path/not_found", 409)):
        with patch("mirage.core.dropbox.readdir.get_metadata",
                   new=_metadata({"/a.txt": "file"})):
            with pytest.raises(NotADirectoryError):
                await readdir(
                    make_accessor(),
                    PathSpec(vfs_path="a.txt/x",
                             virtual="/a.txt/x",
                             directory="/a.txt/x"), index)


@pytest.mark.asyncio
async def test_readdir_on_a_file_is_enotdir_without_walking(index):
    # The operand is itself a file, so the shortcut in readdir_error settles
    # it: one metadata call, none for the ancestors above it.
    seen: list[str] = []

    async def fake(_tm, path: str):
        seen.append(path)
        return {".tag": "file", "name": "a.txt"}

    with patch("mirage.core.dropbox.readdir.list_folder",
               new_callable=AsyncMock,
               side_effect=DropboxApiError("path/not_folder", 409)):
        with patch("mirage.core.dropbox.readdir.get_metadata", new=fake):
            with pytest.raises(NotADirectoryError):
                await readdir(
                    make_accessor(),
                    PathSpec(vfs_path="docs/a.txt",
                             virtual="/docs/a.txt",
                             directory="/docs/a.txt"), index)
    assert seen == ["/docs/a.txt"]
