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

import pytest

from mirage.core.dropbox.readdir import readdir
from mirage.types import FileType, PathSpec
from mirage.utils.key_prefix import mount_key

LIST_ROUTE = "/2/files/list_folder"
METADATA_ROUTE = "/2/files/get_metadata"


@pytest.mark.asyncio
async def test_readdir_root_marks_folders_with_slash(account):
    await account.mkdir("/docs")
    await account.put("/notes.txt", b"x" * 42)
    await account.run.record_requests()
    out = await readdir(
        account.accessor(), PathSpec(vfs_path="", virtual="/", directory="/")
    )
    assert [(row.name, row.type) for row in out] == [
        ("docs", FileType.DIRECTORY),
        ("notes.txt", FileType.FILE),
    ]
    assert out[1].size == 42
    listed = await account.run.bodies("POST", LIST_ROUTE)
    assert [body["path"] for body in listed] == [""]


@pytest.mark.asyncio
async def test_readdir_lists_a_nested_subfolder_by_its_path(account):
    await account.put("/docs/note.md", b"x" * 12)
    out = await readdir(
        account.accessor(),
        PathSpec(vfs_path="docs", virtual="/docs", directory="/docs"),
    )
    assert [row.name for row in out] == ["note.md"]


@pytest.mark.asyncio
async def test_readdir_keeps_empty_files_with_size_zero(account):
    await account.put("/empty.txt", b"")
    out = await readdir(
        account.accessor(), PathSpec(vfs_path="", virtual="/", directory="/")
    )
    assert [(row.name, row.size) for row in out] == [("empty.txt", 0)]


@pytest.mark.asyncio
async def test_readdir_scopes_under_subfolder_root(account):
    await account.put("/Team/data/docs/note.md", b"x" * 12)
    await account.put("/Team/other.txt", b"x")
    accessor = account.accessor("/Team/data")
    root = await readdir(
        accessor, PathSpec(vfs_path="", virtual="/", directory="/")
    )
    nested = await readdir(
        accessor,
        PathSpec(vfs_path="docs", virtual="/docs", directory="/docs"),
    )
    assert [row.name for row in root] == ["docs"]
    assert [row.name for row in nested] == ["note.md"]


@pytest.mark.asyncio
async def test_readdir_honors_mount_prefix(account):
    await account.put("/a.txt", b"x")
    out = await readdir(
        account.accessor(),
        PathSpec(
            virtual="/dropbox",
            directory="/dropbox",
            vfs_path=mount_key("/dropbox", "/dropbox"),
        ),
    )
    assert [row.name for row in out] == ["a.txt"]


@pytest.mark.asyncio
async def test_readdir_maps_409_to_enoent(account):
    with pytest.raises(FileNotFoundError):
        await readdir(
            account.accessor(),
            PathSpec(
                vfs_path="missing", virtual="/missing", directory="/missing"
            ),
        )


@pytest.mark.asyncio
async def test_readdir_of_a_path_no_component_of_which_exists_is_enoent(
    account,
):
    with pytest.raises(FileNotFoundError):
        await readdir(
            account.accessor(),
            PathSpec(
                vfs_path="nope/deeper",
                virtual="/nope/deeper",
                directory="/nope/deeper",
            ),
        )


@pytest.mark.asyncio
async def test_readdir_under_a_file_is_enotdir(account):
    # list_folder answers path/not_found for `/a.txt/x` exactly as it does
    # for a name that is simply absent, so only the ancestor walk can tell
    # GNU's "Not a directory" from "No such file or directory".
    await account.put("/a.txt", b"a")
    with pytest.raises(NotADirectoryError):
        await readdir(
            account.accessor(),
            PathSpec(
                vfs_path="a.txt/x", virtual="/a.txt/x", directory="/a.txt/x"
            ),
        )


@pytest.mark.asyncio
@pytest.mark.usefixtures("exact_cloud_paths")
async def test_readdir_on_a_file_is_enotdir_without_walking(account):
    # The operand is itself a file, so the shortcut in readdir_error settles
    # it: one metadata call, none for the ancestors above it. The spelling
    # check, tested on its own, would walk them first, so it is set aside.
    await account.put("/docs/a.txt", b"a")
    await account.run.record_requests()
    with pytest.raises(NotADirectoryError):
        await readdir(
            account.accessor(),
            PathSpec(
                vfs_path="docs/a.txt",
                virtual="/docs/a.txt",
                directory="/docs/a.txt",
            ),
        )
    asked = await account.run.bodies("POST", METADATA_ROUTE)
    assert [body["path"] for body in asked] == ["/docs/a.txt"]
