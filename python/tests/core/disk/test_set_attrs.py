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

from mirage.accessor.disk import DiskAccessor
from mirage.core.disk.rename import rename
from mirage.core.disk.set_attrs import set_attrs
from mirage.core.disk.stat import stat
from mirage.core.disk.unlink import unlink
from mirage.types import PathSpec


def _spec(path: str) -> PathSpec:
    return PathSpec(resource_path=path.strip("/"),
                    virtual=path,
                    directory=path)


@pytest.fixture
def accessor(tmp_path):
    (tmp_path / "f.txt").write_text("hello")
    return DiskAccessor(tmp_path)


@pytest.mark.asyncio
async def test_set_attrs_mode_hits_inode_no_residual(accessor, tmp_path):
    residual = await set_attrs(accessor, _spec("/f.txt"), mode=0o601)
    assert residual == {}
    real = os.stat(tmp_path / "f.txt")
    assert real.st_mode & 0o777 == 0o601
    result = await stat(accessor, _spec("/f.txt"))
    assert result.mode == 0o601
    os.chmod(tmp_path / "f.txt", 0o644)


@pytest.mark.asyncio
async def test_set_attrs_mode_000_clamps_and_returns_residual(
        accessor, tmp_path):
    residual = await set_attrs(accessor, _spec("/f.txt"), mode=0)
    assert residual == {"mode": 0}
    real = os.stat(tmp_path / "f.txt")
    assert real.st_mode & 0o777 == 0o600
    result = await stat(accessor, _spec("/f.txt"))
    assert result.mode == 0o600
    assert (tmp_path / "f.txt").read_bytes() == b"hello"


@pytest.mark.asyncio
async def test_set_attrs_dir_mode_keeps_owner_traversal(accessor, tmp_path):
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "x.txt").write_text("x")
    residual = await set_attrs(accessor, _spec("/sub"), mode=0o050)
    assert residual == {"mode": 0o050}
    real = os.stat(tmp_path / "sub")
    assert real.st_mode & 0o777 == 0o750
    assert (tmp_path / "sub" / "x.txt").read_text() == "x"
    result = await stat(accessor, _spec("/sub"))
    assert result.mode == 0o750


@pytest.mark.asyncio
async def test_set_attrs_ownership_is_residual_only(accessor, tmp_path):
    before = os.stat(tmp_path / "f.txt")
    residual = await set_attrs(accessor, _spec("/f.txt"), uid=500, gid="dev")
    assert residual == {"uid": 500, "gid": "dev"}
    after = os.stat(tmp_path / "f.txt")
    assert (after.st_uid, after.st_gid) == (before.st_uid, before.st_gid)
    result = await stat(accessor, _spec("/f.txt"))
    assert result.uid is None
    assert result.gid is None


@pytest.mark.asyncio
async def test_stat_reports_external_chmod(accessor, tmp_path):
    os.chmod(tmp_path / "f.txt", 0o640)
    result = await stat(accessor, _spec("/f.txt"))
    assert result.mode == 0o640


@pytest.mark.asyncio
async def test_set_attrs_mtime_hits_inode(accessor, tmp_path):
    await set_attrs(accessor,
                    _spec("/f.txt"),
                    mtime="2026-03-04T12:00:00+00:00")
    result = await stat(accessor, _spec("/f.txt"))
    assert result.modified == "2026-03-04T12:00:00Z"


@pytest.mark.asyncio
async def test_set_attrs_atime_hits_inode(accessor):
    residual = await set_attrs(accessor,
                               _spec("/f.txt"),
                               atime="2026-03-04T12:00:00+00:00")
    assert residual == {}
    result = await stat(accessor, _spec("/f.txt"))
    assert result.atime == "2026-03-04T12:00:00Z"


@pytest.mark.asyncio
async def test_set_attrs_missing_raises(accessor):
    with pytest.raises(FileNotFoundError):
        await set_attrs(accessor, _spec("/nope.txt"), mode=0o644)


@pytest.mark.asyncio
async def test_unlink_then_recreate_resets_mode(accessor, tmp_path):
    await set_attrs(accessor, _spec("/f.txt"), mode=0o601)
    await unlink(accessor, _spec("/f.txt"))
    (tmp_path / "f.txt").write_text("recreated")
    result = await stat(accessor, _spec("/f.txt"))
    assert result.mode != 0o601


@pytest.mark.asyncio
async def test_rename_carries_inode_mode(accessor):
    await set_attrs(accessor, _spec("/f.txt"), mode=0o601)
    await rename(accessor, _spec("/f.txt"), _spec("/g.txt"))
    result = await stat(accessor, _spec("/g.txt"))
    assert result.mode == 0o601
