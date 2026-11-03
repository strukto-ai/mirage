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
import os
import threading
from pathlib import Path

import pytest

from mirage.accessor.disk import DiskAccessor
from mirage.core.disk.rm import rm_r
from mirage.observe.context import RecordingScope
from mirage.observe.record import OpRecord
from mirage.types import PathSpec

pytestmark = pytest.mark.skipif(
    os.geteuid() == 0, reason="root ignores directory modes"
)


async def _rm_r_row(root: Path, target: str, locked: Path, mode: int) -> OpRecord:
    os.chmod(locked, mode)
    scope = RecordingScope()
    try:
        with pytest.raises(PermissionError):
            await rm_r(DiskAccessor(root), PathSpec.from_str_path(target))
    finally:
        scope.close()
        os.chmod(locked, 0o700)
    [row] = scope.records
    return row


@pytest.mark.asyncio
async def test_rm_r_of_an_unreadable_directory_records_a_failed_row(tmp_path):
    (tmp_path / "d").mkdir()
    (tmp_path / "d" / "f").write_bytes(b"f")
    row = await _rm_r_row(tmp_path, "/d", tmp_path / "d", 0)
    assert (tmp_path / "d" / "f").exists()
    assert (row.status, row.changed, row.errno) == (
        "failed",
        False,
        errno.EACCES,
    )


@pytest.mark.asyncio
async def test_rm_r_whose_first_unlink_is_refused_records_a_failed_row(
    tmp_path,
):
    (tmp_path / "d").mkdir()
    (tmp_path / "d" / "f").write_bytes(b"f")
    row = await _rm_r_row(tmp_path, "/d", tmp_path / "d", 0o500)
    assert (tmp_path / "d" / "f").exists()
    assert (row.status, row.changed) == ("failed", False)


@pytest.mark.asyncio
async def test_rm_r_of_an_empty_directory_its_parent_keeps_records_failed(
    tmp_path,
):
    (tmp_path / "x" / "d").mkdir(parents=True)
    row = await _rm_r_row(tmp_path, "/x/d", tmp_path / "x", 0o500)
    assert (tmp_path / "x" / "d").is_dir()
    assert (row.status, row.changed) == ("failed", False)


@pytest.mark.asyncio
async def test_rm_r_records_partial_once_it_removed_an_entry(tmp_path):
    (tmp_path / "x" / "d").mkdir(parents=True)
    (tmp_path / "x" / "d" / "f").write_bytes(b"f")
    row = await _rm_r_row(tmp_path, "/x/d", tmp_path / "x", 0o500)
    assert not (tmp_path / "x" / "d" / "f").exists()
    assert (tmp_path / "x" / "d").is_dir()
    assert (row.status, row.changed, row.errno) == (
        "partial",
        True,
        errno.EACCES,
    )


@pytest.mark.asyncio
async def test_a_cancelled_rm_r_records_partial(tmp_path, monkeypatch):
    (tmp_path / "d").mkdir()
    entered, release = threading.Event(), threading.Event()

    def stalled(path, *, dir_fd=None):
        entered.set()
        release.wait()

    monkeypatch.setattr(os, "rmdir", stalled)
    scope = RecordingScope()
    try:
        task = asyncio.create_task(
            rm_r(DiskAccessor(tmp_path), PathSpec.from_str_path("/d"))
        )
        await asyncio.to_thread(entered.wait)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    finally:
        release.set()
        scope.close()
    [row] = scope.records
    assert (row.status, row.changed) == ("partial", True)
