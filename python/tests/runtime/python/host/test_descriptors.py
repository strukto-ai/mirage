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

from mirage.runtime.handles.mode import parse_mode
from mirage.runtime.python.host.descriptors import open_flags, open_mode


@pytest.mark.parametrize(
    "mode", ["r", "rb", "w", "a", "x", "r+", "w+", "a+", "x+"]
)
def test_a_mode_survives_its_open_flags(mode):
    facts = parse_mode(mode)
    back = open_mode(open_flags(facts))
    assert (
        back.readable,
        back.writable,
        back.truncate,
        back.append,
        back.create,
        back.exclusive,
    ) == (
        facts.readable,
        facts.writable,
        facts.truncate,
        facts.append,
        facts.create,
        facts.exclusive,
    )


def test_a_truncate_on_a_read_only_open_truncates_nothing():
    facts = open_mode(os.O_RDONLY | os.O_TRUNC)
    assert (facts.readable, facts.writable, facts.truncate) == (
        True,
        False,
        False,
    )


def test_an_exclusive_flag_without_a_create_is_not_exclusive():
    assert open_mode(os.O_WRONLY | os.O_EXCL).exclusive is False
