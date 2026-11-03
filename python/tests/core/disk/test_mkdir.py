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

import asyncio
import errno

import aiofiles.os
import pytest

from mirage.accessor.disk import DiskAccessor
from mirage.core.disk import mkdir as mkdir_module
from mirage.core.disk.mkdir import mkdir
from mirage.observe.context import RecordingScope
from mirage.types import PathSpec


def spec(virtual: str) -> PathSpec:
    return PathSpec(
        vfs_path=virtual.lstrip("/"), virtual=virtual, directory=virtual
    )


@pytest.mark.asyncio
async def test_mkdir_creates_a_directory(tmp_path):
    accessor = DiskAccessor(tmp_path)
    await mkdir(accessor, spec("/d"))
    assert (tmp_path / "d").is_dir()


@pytest.mark.asyncio
async def test_mkdir_refuses_an_existing_directory(tmp_path):
    accessor = DiskAccessor(tmp_path)
    await mkdir(accessor, spec("/d"))
    # Only -p is idempotent; plain mkdir refuses an existing target (GNU).
    with pytest.raises(FileExistsError):
        await mkdir(accessor, spec("/d"))
    await mkdir(accessor, spec("/d"), parents=True)


@pytest.mark.asyncio
async def test_mkdir_refuses_an_existing_file(tmp_path):
    (tmp_path / "a.txt").write_bytes(b"hi")
    accessor = DiskAccessor(tmp_path)
    with pytest.raises(FileExistsError):
        await mkdir(accessor, spec("/a.txt"))
    assert (tmp_path / "a.txt").read_bytes() == b"hi"


@pytest.mark.asyncio
async def test_mkdir_p_across_a_file_names_the_component(tmp_path):
    (tmp_path / "a.txt").write_bytes(b"hi")
    accessor = DiskAccessor(tmp_path)
    with pytest.raises(NotADirectoryError) as excinfo:
        await mkdir(accessor, spec("/a.txt/sub"), parents=True)
    # The kernel names the whole path; GNU names the component it tripped
    # on, and the host root never appears.
    assert excinfo.value.filename == "/a.txt"
    assert str(tmp_path) not in str(excinfo.value)
    assert (tmp_path / "a.txt").read_bytes() == b"hi"


@pytest.mark.asyncio
async def test_mkdir_p_onto_a_file_target_is_eexist(tmp_path):
    (tmp_path / "a.txt").write_bytes(b"hi")
    accessor = DiskAccessor(tmp_path)
    with pytest.raises(FileExistsError) as excinfo:
        await mkdir(accessor, spec("/a.txt"), parents=True)
    assert str(tmp_path) not in str(excinfo.value)


@pytest.mark.asyncio
async def test_mkdir_p_builds_the_chain(tmp_path):
    accessor = DiskAccessor(tmp_path)
    await mkdir(accessor, spec("/a/b/c"), parents=True)
    assert (tmp_path / "a" / "b" / "c").is_dir()


@pytest.mark.asyncio
async def test_mkdir_missing_parent_reports_the_virtual_path(tmp_path):
    accessor = DiskAccessor(tmp_path)
    with pytest.raises(FileNotFoundError) as excinfo:
        await mkdir(accessor, spec("/nodir/sub"))
    assert str(tmp_path) not in str(excinfo.value)


@pytest.mark.asyncio
async def test_mkdir_parents_that_made_nothing_records_a_failed_row(tmp_path):
    (tmp_path / "a.txt").write_bytes(b"a")
    scope = RecordingScope()
    try:
        with pytest.raises(NotADirectoryError):
            await mkdir(DiskAccessor(tmp_path), spec("/a.txt/z"), parents=True)
    finally:
        scope.close()
    [row] = scope.records
    assert (row.status, row.changed, row.errno) == (
        "failed",
        False,
        errno.ENOTDIR,
    )


@pytest.mark.asyncio
async def test_mkdir_parents_records_partial_once_it_made_a_directory(
    tmp_path,
):
    scope = RecordingScope()
    try:
        with pytest.raises(OSError):
            await mkdir(
                DiskAccessor(tmp_path), spec(f"/x/{'n' * 300}"), parents=True
            )
    finally:
        scope.close()
    assert (tmp_path / "x").is_dir()
    [row] = scope.records
    # Linux's number on every host: macOS's own ENAMETOOLONG is 63.
    assert (row.status, row.changed, row.errno) == ("partial", True, 36)


@pytest.mark.asyncio
async def test_a_cancelled_mkdir_parents_records_partial_without_probing(
    tmp_path, monkeypatch
):
    accessor = DiskAccessor(tmp_path)
    entered = asyncio.Event()

    async def stalled(path, exist_ok=False):
        entered.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(aiofiles.os, "makedirs", stalled)
    scope = RecordingScope()
    try:
        task = asyncio.create_task(mkdir(accessor, spec("/a/b"), parents=True))
        await entered.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    finally:
        scope.close()
    [row] = scope.records
    assert (row.status, row.changed) == ("partial", True)


@pytest.mark.asyncio
async def test_mkdir_parents_whose_chain_no_probe_could_see_records_partial(
    tmp_path, monkeypatch
):
    (tmp_path / "a.txt").write_bytes(b"a")

    def unprobeable(path):
        raise OSError(errno.EIO, "probe")

    monkeypatch.setattr(mkdir_module, "_first_missing", unprobeable)
    scope = RecordingScope()
    try:
        with pytest.raises(NotADirectoryError):
            await mkdir(DiskAccessor(tmp_path), spec("/a.txt/z"), parents=True)
    finally:
        scope.close()
    [row] = scope.records
    assert (row.status, row.changed, row.errno) == ("partial", True, 20)
