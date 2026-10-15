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

import os

import pytest

from mirage import MountMode, Workspace
from mirage.accessor.disk import DiskAccessor
from mirage.cache.index import IndexEntry, ResourceType
from mirage.core.disk.stat import stat
from mirage.types import FileType, PathSpec, ReadPolicy, ReadSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.disk import DiskVFS
from mirage.workspace.mount import Mount
from mirage.workspace.reconcile import Reconciler


@pytest.mark.asyncio
async def test_stat_file(tmp_path):
    (tmp_path / "hello.txt").write_text("hello")
    accessor = DiskAccessor(tmp_path)
    result = await stat(
        accessor,
        PathSpec(
            vfs_path=mount_key("/hello.txt", "/disk"),
            virtual="/hello.txt",
            directory="/hello.txt",
        ),
    )
    assert result.name == "hello.txt"
    assert result.size == 5
    assert result.modified is not None
    assert result.modified.endswith("Z")
    assert "+00:00" not in result.modified
    assert result.type != FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_directory(tmp_path):
    (tmp_path / "sub").mkdir()
    accessor = DiskAccessor(tmp_path)
    result = await stat(
        accessor,
        PathSpec(vfs_path="sub", virtual="/sub", directory="/sub"),
    )
    assert result.type == FileType.DIRECTORY
    assert result.size is None


@pytest.mark.asyncio
async def test_stat_file_not_found(tmp_path):
    accessor = DiskAccessor(tmp_path)
    with pytest.raises(FileNotFoundError):
        await stat(
            accessor,
            PathSpec(
                vfs_path="missing.txt",
                virtual="/missing.txt",
                directory="/missing.txt",
            ),
        )


@pytest.mark.asyncio
async def test_stat_with_glob_scope(tmp_path):
    (tmp_path / "a.txt").write_text("data")
    accessor = DiskAccessor(tmp_path)
    scope = PathSpec(
        vfs_path=mount_key("/disk/a.txt", "/disk"),
        virtual="/disk/a.txt",
        directory="/disk/",
    )
    result = await stat(accessor, scope)
    assert result.name == "a.txt"
    assert result.size == 4


@pytest.mark.asyncio
async def test_stat_with_prefix(tmp_path):
    (tmp_path / "a.txt").write_text("data")
    accessor = DiskAccessor(tmp_path)
    result = await stat(
        accessor,
        PathSpec(
            vfs_path=mount_key("/disk/a.txt", "/disk"),
            virtual="/disk/a.txt",
            directory="/disk/a.txt",
        ),
    )
    assert result.name == "a.txt"
    assert result.size == 4


# A path under a plain file is ENOTDIR on the real filesystem, and the
# error names the virtual path, never the host one the mount resolves to.
@pytest.mark.asyncio
async def test_stat_under_a_plain_file_is_not_a_directory(tmp_path):
    (tmp_path / "a.txt").write_text("a")
    spec = PathSpec(
        vfs_path="a.txt/x", virtual="/a.txt/x", directory="/a.txt/"
    )
    with pytest.raises(NotADirectoryError) as exc:
        await stat(DiskAccessor(tmp_path), spec)
    assert exc.value.filename == "/a.txt/x"
    assert str(tmp_path) not in str(exc.value)


@pytest.mark.asyncio
async def test_stat_keeps_the_fraction_of_a_second(tmp_path):
    target = tmp_path / "half.txt"
    target.write_text("x")
    os.utime(target, ns=(1_704_067_200_250_000_000, 1_704_067_200_500_000_000))
    result = await stat(
        DiskAccessor(tmp_path),
        PathSpec(
            vfs_path="half.txt", virtual="/half.txt", directory="/half.txt"
        ),
    )
    assert result.modified == "2024-01-01T00:00:00.500Z"
    assert result.atime == "2024-01-01T00:00:00.250Z"


@pytest.mark.asyncio
@pytest.mark.parametrize("quiet", [False, True])
async def test_a_folder_with_an_overlay_still_drops_the_index_under_fresh(
    tmp_path, monkeypatch, quiet
):
    folder = tmp_path / "d"
    folder.mkdir()
    if quiet:
        # Past the racy window the folder's stat carries a version, so the
        # probe compares it instead of finding no fingerprint at all.
        st = os.stat(folder)
        quiet_ns = max(st.st_ctime_ns, st.st_mtime_ns) + 3_000_000_000
        monkeypatch.setattr(
            "mirage.core.disk.listing_version.time_ns", lambda: quiet_ns
        )
    ws = Workspace(
        {
            "/m": Mount(
                vfs=DiskVFS(str(tmp_path)),
                mode=MountMode.WRITE,
                read=ReadSpec(policy=ReadPolicy.FRESH, ttl=600),
            )
        }
    )
    try:
        await ws.namespace.ensure_loaded()
        await ws.namespace.set_attrs("/m/d", uid=1000)
        mount = ws.namespace.mount_for("/m/d")
        await mount.index_store.set_dir(
            "/m/d",
            [
                (
                    "x.txt",
                    IndexEntry(
                        id="/d/x.txt",
                        name="x.txt",
                        resource_type=ResourceType.FILE,
                    ),
                )
            ],
        )
        assert (await mount.index_store.list_dir("/m/d")).entries is not None
        await Reconciler(ws.cache, ws.namespace).reconcile_read(mount, "/m/d")
        assert (await mount.index_store.list_dir("/m/d")).entries is None
    finally:
        await ws.close()
