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

from mirage.accessor.disk import DiskAccessor
from mirage.core.disk.readdir import readdir
from mirage.core.disk.stat import stat
from mirage.types import DirListing, PathSpec
from mirage.utils.key_prefix import mount_key


def _paths(listing: DirListing, virtual: str) -> list[str]:
    return [f"{virtual.rstrip('/')}/{row.name}" for row in listing.entries]


@pytest.mark.asyncio
async def test_empty_directory(tmp_path):
    accessor = DiskAccessor(tmp_path)
    result = await readdir(
        accessor,
        PathSpec(vfs_path=mount_key("/", "/disk"), virtual="/", directory="/"),
    )
    assert result.entries == []


@pytest.mark.asyncio
async def test_directory_with_files(tmp_path):
    (tmp_path / "a.txt").write_text("a")
    (tmp_path / "b.txt").write_text("b")
    accessor = DiskAccessor(tmp_path)
    result = await readdir(
        accessor, PathSpec(vfs_path="", virtual="/", directory="/")
    )
    assert _paths(result, "/") == ["/a.txt", "/b.txt"]


@pytest.mark.asyncio
async def test_directory_with_subdirectories(tmp_path):
    (tmp_path / "sub").mkdir()
    (tmp_path / "file.txt").write_text("x")
    accessor = DiskAccessor(tmp_path)
    result = await readdir(
        accessor, PathSpec(vfs_path="", virtual="/", directory="/")
    )
    assert _paths(result, "/") == ["/file.txt", "/sub"]


@pytest.mark.asyncio
async def test_each_row_is_what_stat_answers(tmp_path):
    (tmp_path / "sub").mkdir()
    (tmp_path / "file.txt").write_text("data")
    accessor = DiskAccessor(tmp_path)
    result = await readdir(
        accessor, PathSpec(vfs_path="", virtual="/", directory="/")
    )
    for row in result.entries:
        spec = PathSpec(
            vfs_path=row.name, virtual=f"/{row.name}", directory=f"/{row.name}"
        )
        assert row == await stat(accessor, spec)


@pytest.mark.asyncio
async def test_with_prefix(tmp_path):
    (tmp_path / "a.txt").write_text("a")
    accessor = DiskAccessor(tmp_path)
    result = await readdir(
        accessor,
        PathSpec(
            vfs_path=mount_key("/disk/", "/disk"),
            virtual="/disk/",
            directory="/disk/",
        ),
    )
    assert _paths(result, "/disk/") == ["/disk/a.txt"]


@pytest.mark.asyncio
async def test_with_glob_scope(tmp_path):
    (tmp_path / "a.txt").write_text("a")
    accessor = DiskAccessor(tmp_path)
    scope = PathSpec(
        vfs_path=mount_key("/disk/", "/disk"),
        virtual="/disk/",
        directory="/disk/",
    )
    result = await readdir(accessor, scope)
    assert _paths(result, "/disk/") == ["/disk/a.txt"]


@pytest.mark.asyncio
async def test_not_a_directory(tmp_path):
    (tmp_path / "file.txt").write_text("x")
    accessor = DiskAccessor(tmp_path)
    with pytest.raises(NotADirectoryError):
        await readdir(
            accessor,
            PathSpec(
                vfs_path="file.txt", virtual="/file.txt", directory="/file.txt"
            ),
        )


@pytest.mark.asyncio
async def test_a_trailing_slash_lists_the_same(tmp_path):
    (tmp_path / "a.txt").write_text("a")
    accessor = DiskAccessor(tmp_path)
    slashed = PathSpec(
        vfs_path=mount_key("/data/", "/data"),
        virtual="/data/",
        directory="/data/",
    )
    bare = PathSpec(
        vfs_path=mount_key("/data", "/data"),
        virtual="/data",
        directory="/data",
    )
    first = await readdir(accessor, slashed)
    second = await readdir(accessor, bare)
    assert _paths(first, "/data") == _paths(second, "/data") == ["/data/a.txt"]


@pytest.mark.asyncio
async def test_missing_path_is_not_found(tmp_path):
    (tmp_path / "sub").mkdir()
    accessor = DiskAccessor(tmp_path)
    # GNU `ls /nope` -> "No such file or directory", and it stays ENOENT
    # however deep the missing component is.
    for virtual in ("/nope", "/sub/nope", "/nope/deeper"):
        with pytest.raises(FileNotFoundError):
            await readdir(
                accessor,
                PathSpec(
                    vfs_path=virtual.lstrip("/"),
                    virtual=virtual,
                    directory=virtual,
                ),
            )


@pytest.mark.asyncio
async def test_file_component_is_not_a_directory(tmp_path):
    (tmp_path / "file.txt").write_text("x")
    accessor = DiskAccessor(tmp_path)
    for virtual in ("/file.txt/x", "/file.txt/x/y"):
        with pytest.raises(NotADirectoryError):
            await readdir(
                accessor,
                PathSpec(
                    vfs_path=virtual.lstrip("/"),
                    virtual=virtual,
                    directory=virtual,
                ),
            )


@pytest.mark.asyncio
async def test_readdir_error_reports_the_virtual_path(tmp_path):
    accessor = DiskAccessor(tmp_path)
    # The real filesystem path under tmp_path must never reach the operand
    # a user-facing stderr line is built from.
    with pytest.raises(FileNotFoundError) as excinfo:
        await readdir(
            accessor,
            PathSpec(vfs_path="nope", virtual="/nope", directory="/nope"),
        )
    assert excinfo.value.filename == "/nope"
    assert str(tmp_path) not in str(excinfo.value)


@pytest.mark.asyncio
async def test_leaves_a_host_symlink_out(tmp_path):
    (tmp_path / "lib").mkdir()
    (tmp_path / "lib64").symlink_to("lib")
    (tmp_path / "python").symlink_to("/nowhere/python3")
    accessor = DiskAccessor(tmp_path)
    result = await readdir(
        accessor, PathSpec(vfs_path="", virtual="/", directory="/")
    )
    assert _paths(result, "/") == ["/lib"]


@pytest.mark.asyncio
async def test_refuses_a_directory_reached_through_a_host_symlink(tmp_path):
    (tmp_path / "lib").mkdir()
    (tmp_path / "lib64").symlink_to("lib")
    accessor = DiskAccessor(tmp_path)
    with pytest.raises(FileNotFoundError):
        await readdir(
            accessor,
            PathSpec(vfs_path="lib64", virtual="/lib64", directory="/lib64"),
        )
