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

from dataclasses import replace

from mirage.core.machine.fingerprint import token_of
from mirage.core.posix.types import PosixEntry
from mirage.utils.constants import RACY_WINDOW_NS

WRITTEN_MS = 1_700_000_000_123
SETTLED = WRITTEN_MS * 1_000_000 + RACY_WINDOW_NS
ENTRY = PosixEntry(
    "f",
    0o644,
    12,
    1700000000,
    1700000000,
    WRITTEN_MS,
    WRITTEN_MS,
    1000,
    50,
    1,
    8,
    "",
    asked_ns=SETTLED,
)


def test_a_settled_entry_is_named_by_its_size_and_millisecond():
    assert token_of(ENTRY) == "12:1700000000123"


def test_an_entry_inside_the_racy_window_has_none():
    assert token_of(replace(ENTRY, asked_ns=SETTLED - 1)) is None


def test_an_entry_with_no_asking_time_kept_has_none():
    assert token_of(replace(ENTRY, asked_ns=0)) is None
