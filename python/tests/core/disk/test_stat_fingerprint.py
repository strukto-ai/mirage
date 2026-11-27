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
import os

from mirage.accessor.disk import DiskAccessor
from mirage.core.disk.stat import stat
from mirage.types import PathSpec


def test_a_settled_file_stats_its_fingerprint(tmp_path, monkeypatch):
    p = tmp_path / "f.txt"
    p.write_bytes(b"hi")
    st = os.stat(p)
    later = max(st.st_ctime_ns, st.st_mtime_ns) + 3_000_000_000
    monkeypatch.setattr("mirage.utils.dates.time_ns", lambda: later)
    accessor = DiskAccessor(root=tmp_path)
    scope = PathSpec(vfs_path="f.txt", virtual="/f.txt", directory="/")
    result = asyncio.run(stat(accessor, scope))
    assert result.fingerprint == (
        f"{st.st_dev}:{st.st_ino}:{st.st_ctime_ns}:{st.st_mtime_ns}"
    )


def test_a_file_written_just_now_stats_no_fingerprint(tmp_path, monkeypatch):
    p = tmp_path / "f.txt"
    p.write_bytes(b"hi")
    st = os.stat(p)
    inside = max(st.st_ctime_ns, st.st_mtime_ns) + 1_000_000_000
    monkeypatch.setattr("mirage.utils.dates.time_ns", lambda: inside)
    accessor = DiskAccessor(root=tmp_path)
    scope = PathSpec(vfs_path="f.txt", virtual="/f.txt", directory="/")
    assert asyncio.run(stat(accessor, scope)).fingerprint is None
