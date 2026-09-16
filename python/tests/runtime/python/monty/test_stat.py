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

from mirage.runtime.python.monty.binding import pydantic_monty
from mirage.runtime.python.monty.stat import stat_result
from mirage.runtime.types import VFSStat

pytestmark = pytest.mark.skipif(pydantic_monty is None,
                                reason="the monty extra is not installed")


def test_file_row_keeps_size_mode_and_stamp() -> None:
    st = stat_result(
        VFSStat(size=5, is_dir=False, mtime_ns=1_500_000_000, mode=0o100644))
    assert st.st_size == 5
    assert st.st_mode == 0o100644
    assert st.st_mtime == 1.5
    assert st.st_nlink == 1


def test_directory_row_is_monty_s_own_four_kilobytes_and_two_links() -> None:
    st = stat_result(
        VFSStat(size=17, is_dir=True, mtime_ns=2_000_000_000, mode=0o40755))
    assert st.st_mode == 0o40755
    assert st.st_size == 4096
    assert st.st_nlink == 2


def test_unknown_stamp_stays_zero_rather_than_becoming_now() -> None:
    # 0 is the door's spelling of "no stamp"; monty reads 0.0 as epoch
    # zero rather than substituting the host clock.
    assert stat_result(VFSStat(size=0, is_dir=False, mtime_ns=0,
                               mode=0o644)).st_mtime == 0.0


def test_the_sequence_half_is_this_host_s_alone() -> None:
    # The python binding builds a real namedtuple, so a guest may
    # subscript, iterate and len the answer. The TypeScript twin sends
    # a class instance (the JS wire has no namedtuple shape), where
    # only the attributes cross; `integ/runtime/monty.json` pins both
    # sides of that divergence.
    st = stat_result(VFSStat(size=5, is_dir=False, mtime_ns=0, mode=0o644))
    assert len(st) == 10
    assert st[0] == st.st_mode
    assert st[6] == st.st_size
