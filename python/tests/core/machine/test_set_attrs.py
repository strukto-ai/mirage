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

from mirage.core.machine.capacity import capacity
from mirage.core.machine.set_attrs import attrs_command, set_attrs
from mirage.types import CapacityState, PathSpec
from tests.fixtures.machine import ScriptedMachine, ok
from tests.fixtures.machine_files import bound, spec


def test_attrs_command_sets_every_field_asked():
    assert attrs_command("/t/x", None, None, None, None, None) is None
    assert attrs_command(
        "/t/x", 0o640, "app", "staff", None, "2024-01-01T00:00:00+00:00"
    ) == (
        "chmod 640 -- '/t/x' && chown 'app:staff' -- '/t/x'"
        " && touch -c -m -d @1704067200.0 -- '/t/x'"
    )
    assert attrs_command("/t/x", None, None, 7, None, None) == (
        "chgrp '7' -- '/t/x'"
    )


@pytest.mark.asyncio
async def test_set_attrs_leaves_nothing_to_an_overlay():
    box = ScriptedMachine("box", lambda line, data: ok())
    assert await set_attrs(bound(box), "box", spec("/x"), mode=0o600) == {}
    assert box.lines == ["chmod 600 -- '/tmp/x'"]


@pytest.mark.asyncio
async def test_capacity_reads_df():
    out = (
        b"Filesystem 1024-blocks Used Available Capacity Mounted on\n"
        b"overlay 100 40 60 40% /\n"
    )
    box = ScriptedMachine("box", lambda line, data: ok(out))
    got = await capacity(bound(box), PathSpec.from_str_path("/"))
    assert (got.state, got.total, got.used, got.available) == (
        CapacityState.QUOTA,
        102400,
        40960,
        61440,
    )
    odd = ScriptedMachine("odd", lambda line, data: ok(b"what\n"))
    got = await capacity(bound(odd), PathSpec.from_str_path("/"))
    assert got.state is CapacityState.UNKNOWN
