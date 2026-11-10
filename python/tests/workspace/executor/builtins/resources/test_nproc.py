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

from mirage.workspace.executor.builtins.resources.nproc import handle_nproc
from tests.fixtures.machine_resources import resources, table_of


@pytest.mark.asyncio
async def test_workspace_comes_first_with_one_processor():
    out, io, _ = await handle_nproc(table_of(resources()), ["nproc"])
    assert out.decode() == "1  mirage\n4  docker:a\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_several_machines_never_add_up():
    table = table_of(
        resources("docker:a", cpus=14), resources("e2b:b", cpus=2)
    )
    out, _, _ = await handle_nproc(table, ["nproc"])
    assert out.decode() == " 1  mirage\n14  docker:a\n 2  e2b:b\n"


@pytest.mark.asyncio
async def test_all_and_ignore_apply_to_each_machine():
    out, _, _ = await handle_nproc(
        table_of(resources()), ["nproc", "--all", "--ignore=3"]
    )
    assert out == b"1  mirage\n5  docker:a\n"


@pytest.mark.asyncio
async def test_machine_picks_one():
    table = table_of(resources("docker:a"), resources("e2b:b", cpus=2))
    out, _, _ = await handle_nproc(table, ["nproc", "--machine", "e2b:b"])
    assert out == b"2\n"


@pytest.mark.asyncio
async def test_machine_picks_the_workspace():
    out, _, _ = await handle_nproc(
        table_of(resources()), ["nproc", "--machine", "mirage"]
    )
    assert out == b"1\n"


@pytest.mark.asyncio
async def test_bad_ignore_is_refused():
    _, io, _ = await handle_nproc(
        table_of(resources()), ["nproc", "--ignore=x"]
    )
    assert io.stderr == b"nproc: invalid number: 'x'\n"
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_unknown_machine_is_refused():
    _, io, _ = await handle_nproc(
        table_of(resources()), ["nproc", "--machine", "nosuch"]
    )
    assert io.stderr == b"nproc: nosuch: no such machine\n"
    assert io.exit_code == 1
