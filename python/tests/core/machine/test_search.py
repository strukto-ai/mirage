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

from mirage.core.machine.search import files_containing
from tests.fixtures.machine import ScriptedMachine, ok
from tests.fixtures.machine_files import DIR, bound, spec


def searched(name: str, matched: bytes, held: bytes) -> ScriptedMachine:
    """A machine whose grep names ``matched`` and whose find lists
    ``held`` under the directory."""

    def answer(line, data):
        return ok(DIR + held) if " find " in line else ok(matched)

    return ScriptedMachine(name, answer)


@pytest.mark.asyncio
async def test_a_match_in_an_older_copy_is_none():
    a = searched(
        "a",
        b"/tmp/d/x\0/tmp/d/only-a\0",
        b"f 644 1 3 0 0 0 1 0 x\0f 644 1 3 0 0 0 1 0 only-a\0",
    )
    b = searched("b", b"", b"f 644 1 9 0 0 0 1 0 x\0")
    found = await files_containing(
        bound(a, b), ["a", "b"], spec("/d"), "needle", False
    )
    assert found is not None
    assert [p.virtual for p in found] == ["/tmp/d/only-a"]
    assert sum(" find " in line for line in a.lines) == 1


@pytest.mark.asyncio
async def test_one_machine_s_matches_ask_no_listing():
    a = searched("a", b"/tmp/d/x\0", b"")
    found = await files_containing(
        bound(a), ["a"], spec("/d"), "needle", False
    )
    assert found is not None
    assert [p.virtual for p in found] == ["/tmp/d/x"]
    assert not any(" find " in line for line in a.lines)
