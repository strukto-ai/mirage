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

from mirage.workspace.executor.builtins.resources.lscpu import handle_lscpu
from tests.fixtures.machine_resources import resources, table_of

ARM = (
    "Architecture:                            aarch64\n"
    "Byte Order:                              Little Endian\n"
    "CPU(s):                                  1\n"
    "Model name:                              -\n"
    "Cluster(s):                              1\n"
    "Flags:                                   fp asimd\n"
    "Vulnerability L1tf:                      Not affected\n"
)
INTEL = (
    "Architecture:                            x86_64\n"
    "Byte Order:                              Little Endian\n"
    "CPU(s):                                  2\n"
    "Model name:                              Intel Xeon\n"
    "Socket(s):                               1\n"
)


@pytest.mark.asyncio
async def test_a_column_a_machine_with_dashes_for_the_workspace():
    table = table_of(
        resources("docker:a", cpu_info=ARM),
        resources("e2b:b", cpu_info=INTEL),
    )
    out, io, _ = await handle_lscpu(table, ["lscpu"])
    assert out.decode().splitlines() == [
        "               mirage         docker:a       e2b:b",
        "Architecture:  -              aarch64        x86_64",
        "Byte Order:    Little Endian  Little Endian  Little Endian",
        "CPU(s):        1              1              2",
        "Model name:    -              -              Intel Xeon",
        "Socket(s):     -              -              1",
        "Cluster(s):    -              1              -",
    ]
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_machine_prints_it_as_the_machine_did():
    table = table_of(
        resources("docker:a", cpu_info=ARM),
        resources("e2b:b", cpu_info=INTEL),
    )
    out, _, _ = await handle_lscpu(table, ["lscpu", "--machine", "docker:a"])
    assert out.decode() == ARM


@pytest.mark.asyncio
async def test_machine_picks_the_workspace():
    out, _, _ = await handle_lscpu(
        table_of(resources(cpu_info=ARM)), ["lscpu", "--machine=mirage"]
    )
    assert out.decode() == (
        "Byte Order:" + " " * 30 + "Little Endian\nCPU(s):" + " " * 34 + "1\n"
    )


@pytest.mark.asyncio
async def test_a_machine_without_it_is_a_column_of_dashes():
    table = table_of(resources("docker:a"), resources("e2b:b", cpu_info=INTEL))
    out, _, _ = await handle_lscpu(table, ["lscpu"])
    assert out.decode().splitlines()[1] == (
        "Architecture:  -              -         x86_64"
    )


@pytest.mark.asyncio
async def test_one_machine_without_it_is_not_found():
    _, io, _ = await handle_lscpu(
        table_of(resources("docker:a"), resources("e2b:b")),
        ["lscpu", "--machine", "docker:a"],
    )
    assert io.exit_code == 127
    assert io.stderr.endswith(b"lscpu: command not found\n")


@pytest.mark.asyncio
async def test_unknown_machine_is_refused():
    _, io, _ = await handle_lscpu(
        table_of(resources()), ["lscpu", "--machine", "nosuch"]
    )
    assert io.stderr == b"lscpu: nosuch: no such machine\n"
    assert io.exit_code == 1
