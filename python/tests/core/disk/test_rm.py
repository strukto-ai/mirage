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

import errno
import os

import pytest

from mirage.accessor.disk import DiskAccessor
from mirage.core.disk.rm import rm_r
from mirage.observe.context import RecordingScope
from mirage.observe.record import OpRecord
from mirage.types import PathSpec

pytestmark = pytest.mark.skipif(
    os.geteuid() == 0, reason="root ignores directory modes"
)


async def _rm_r_row(tmp_path, locked: str) -> OpRecord:
    d = tmp_path / "d"
    (d / "s").mkdir(parents=True)
    (d / "f").write_bytes(b"f")
    (d / "s" / "g").write_bytes(b"g")
    os.chmod(tmp_path / locked, 0o500 if locked != "d" else 0)
    scope = RecordingScope()
    try:
        with pytest.raises(PermissionError):
            await rm_r(DiskAccessor(tmp_path), PathSpec.from_str_path("/d"))
    finally:
        scope.close()
        os.chmod(tmp_path / locked, 0o700)
    [row] = scope.records
    return row


@pytest.mark.asyncio
async def test_rm_r_that_removed_nothing_records_a_failed_row(tmp_path):
    row = await _rm_r_row(tmp_path, "d")
    assert (tmp_path / "d" / "f").exists()
    assert (row.status, row.changed, row.errno) == (
        "failed",
        False,
        errno.EACCES,
    )


@pytest.mark.asyncio
async def test_rm_r_records_partial_once_it_got_inside(tmp_path):
    row = await _rm_r_row(tmp_path, "d/s")
    assert (row.status, row.changed, row.errno) == (
        "partial",
        True,
        errno.EACCES,
    )
