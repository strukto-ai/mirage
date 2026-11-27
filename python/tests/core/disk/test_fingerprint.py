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

from mirage.core.disk.fingerprint import token_of
from mirage.utils.constants import RACY_WINDOW_NS


def settled(st: os.stat_result) -> int:
    return max(st.st_ctime_ns, st.st_mtime_ns) + RACY_WINDOW_NS


def test_a_settled_entry_is_named_by_device_inode_and_both_times(tmp_path):
    p = tmp_path / "f"
    p.write_bytes(b"one")
    st = os.stat(p)
    assert token_of(st, settled(st)) == (
        f"{st.st_dev}:{st.st_ino}:{st.st_ctime_ns}:{st.st_mtime_ns}"
    )


def test_an_entry_inside_the_racy_window_has_none(tmp_path):
    p = tmp_path / "f"
    p.write_bytes(b"one")
    st = os.stat(p)
    assert token_of(st, settled(st) - 1) is None


def test_a_same_size_rewrite_moves_it(tmp_path):
    p = tmp_path / "f"
    p.write_bytes(b"one")
    first = os.stat(p)
    os.utime(p, ns=(first.st_atime_ns, first.st_mtime_ns - 10**9))
    before = os.stat(p)
    p.write_bytes(b"two")
    after = os.stat(p)
    now = max(settled(before), settled(after))
    assert token_of(before, now) != token_of(after, now)
