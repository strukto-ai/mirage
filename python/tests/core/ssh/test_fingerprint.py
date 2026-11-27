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

from mirage.core.ssh.fingerprint import token_of
from mirage.utils.constants import RACY_WINDOW_NS

WRITTEN = 1_700_000_000
SETTLED = WRITTEN * 1_000_000_000 + RACY_WINDOW_NS


def test_a_settled_file_is_named_by_its_size_and_second():
    assert token_of(5, WRITTEN, SETTLED) == "5:1700000000"


def test_a_file_inside_the_racy_window_has_none():
    assert token_of(5, WRITTEN, SETTLED - 1) is None


def test_a_file_without_a_size_or_a_time_has_none():
    assert token_of(None, WRITTEN, SETTLED) is None
    assert token_of(5, None, SETTLED) is None
