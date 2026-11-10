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

from mirage.workspace.executor.builtins.resources.hostname import (
    handle_hostname,
)
from tests.fixtures.machine_resources import resources, table_of


@pytest.mark.asyncio
async def test_lists_the_workspace_then_each_machine():
    table = table_of(
        resources("docker:a", hostname="box-one"),
        resources("e2b:b", hostname="e2b.local"),
    )
    out, io, _ = await handle_hostname(table, ["hostname"])
    assert out.decode() == ("mirage\nbox-one\ne2b.local\n")
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_machine_picks_one():
    table = table_of(
        resources("docker:a", hostname="box-one"),
        resources("e2b:b", hostname="e2b.local"),
    )
    out, _, _ = await handle_hostname(table, ["hostname", "--machine=b"])
    assert out == b"e2b.local\n"


@pytest.mark.asyncio
async def test_machine_picks_the_workspace():
    out, _, _ = await handle_hostname(
        table_of(resources(hostname="box-one")),
        ["hostname", "--machine", "mirage"],
    )
    assert out == b"mirage\n"


@pytest.mark.asyncio
async def test_unknown_machine_is_refused():
    _, io, _ = await handle_hostname(
        table_of(resources()), ["hostname", "--machine", "nosuch"]
    )
    assert io.stderr == b"hostname: nosuch: no such machine\n"
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_a_silent_machine_leaves_its_row_out():
    table = table_of(
        resources("docker:a", hostname="box-one"),
        ids=[
            "docker:a",
            "e2b:b",
        ],
    )
    out, io, _ = await handle_hostname(table, ["hostname"])
    assert out.decode() == "mirage\nbox-one\n"
    assert io.stderr == b"hostname: e2b:b: machine did not answer\n"
    assert io.exit_code == 1
