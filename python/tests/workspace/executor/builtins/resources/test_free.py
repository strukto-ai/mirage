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

from mirage.io.memory import MemoryBudget, run_with_memory
from mirage.workspace.executor.builtins.resources.free import (
    handle_free,
    human_size,
)
from tests.fixtures.machine_resources import resources, table_of

HEADER = (
    "               total        used        free      shared  buff/cache"
    "   available"
)
MEM = "Mem:         8000000     1456790     1234567       12345     2511110     6543210"
SWAP = "Swap:        2097148       97148     2000000"


async def free_of(*words: str, table=None) -> tuple[str, str, int]:
    picked = () if table is not None else ("--machine", "docker:a")
    out, io, _ = await handle_free(
        table or table_of(resources()), ["free", *picked, *words]
    )
    stderr = (io.stderr or b"").decode()
    return (out or b"").decode(), stderr, io.exit_code


@pytest.mark.parametrize(
    ("kib", "shown"),
    [
        (0, "0B"),
        (1, "1.0Ki"),
        (9, "9.0Ki"),
        (10, "10Ki"),
        (512, "512Ki"),
        (999, "999Ki"),
        (1000, "1.0Mi"),
        (1024, "1.0Mi"),
        (1536, "1.5Mi"),
        (10188, "9.9Mi"),
        (10189, "9Mi"),
        (10239, "9Mi"),
        (10240, "10Mi"),
        (102400, "100Mi"),
        (1100000, "1.0Gi"),
        (10433331, "9.9Gi"),
        (10433332, "9Gi"),
        (10485760, "10Gi"),
        (1099511627776, "1.0Pi"),
    ],
)
def test_human_size_rounds_as_procps_does(kib: int, shown: str):
    assert human_size(kib * 1024, False) == shown


@pytest.mark.asyncio
async def test_free_prints_kibibytes_by_default():
    out, _, code = await free_of()
    assert out == f"{HEADER}\n{MEM}\n{SWAP}\n"
    assert code == 0


@pytest.mark.parametrize(
    ("words", "total"),
    [
        (["-b"], "8192000000"),
        (["--kilo"], "8192000"),
        (["--mega"], "8192"),
        (["--giga"], "8"),
        (["-m"], "7812"),
        (["-g"], "7"),
        (["--si"], "8192000"),
        (["--si", "-m"], "8192"),
    ],
)
@pytest.mark.asyncio
async def test_units_scale_every_figure(words: list[str], total: str):
    out, _, _ = await free_of(*words)
    assert out.splitlines()[1].split()[1] == total


@pytest.mark.asyncio
async def test_human_with_si_drops_the_i():
    out, _, _ = await free_of("-h", "--si")
    assert out.splitlines()[1].split()[1:3] == ["8.2G", "1.5G"]


@pytest.mark.asyncio
async def test_total_committed_and_low_rows():
    out, _, _ = await free_of("-t", "-v", "-l")
    rows = out.splitlines()
    assert rows[2] == "Low:         8000000     6765433     1234567"
    assert rows[3] == "High:              0           0           0"
    assert rows[5] == "Total:      10097148     1553938     3234567"
    assert rows[6] == "Comm:        6097148     3000000     3097148"


@pytest.mark.asyncio
async def test_wide_splits_buffers_from_cache():
    out, _, _ = await free_of("-w")
    rows = out.splitlines()
    assert rows[0].split()[4:6] == ["buffers", "cache"]
    assert rows[1].split()[5:7] == ["54321", "2456789"]


@pytest.mark.asyncio
async def test_line_form():
    out, _, _ = await free_of("-L")
    assert out == (
        "SwapUse       97148 CachUse     2511110  MemUse     1456790 "
        "MemFree     1234567 \n"
    )


@pytest.mark.asyncio
async def test_several_machines_keep_each_figure_where_it_was():
    table = table_of(resources("docker:a"), resources("e2b:b"))
    out, _, _ = await free_of(table=table)
    rows = out.splitlines()
    assert rows[0] == f"{HEADER}  MACHINE"
    assert rows[3] == f"{MEM}  docker:a"
    assert rows[4].endswith("  docker:a")
    assert len(rows[4]) == len(rows[3])
    assert rows[5] == f"{MEM}  e2b:b"
    assert [row.split()[1] for row in (rows[3], rows[5])] == ["8000000"] * 2


@pytest.mark.asyncio
async def test_the_workspace_row_is_its_max_memory():
    budget = MemoryBudget(32 << 20, lambda: 2 << 20)
    out, _, _ = await run_with_memory(
        budget, free_of("-m", table=table_of(resources()))
    )
    rows = out.splitlines()
    assert rows[1].split() == [
        "Mem:",
        "32",
        "2",
        "30",
        "-",
        "-",
        "30",
        "mirage",
    ]
    assert rows[2].split() == ["Swap:", "0", "0", "0", "mirage"]


@pytest.mark.asyncio
async def test_no_max_memory_leaves_the_workspace_row_blank():
    out, _, _ = await free_of("-m", table=table_of(resources()))
    rows = out.splitlines()
    assert rows[1].split() == ["Mem:", *"------", "mirage"]
    assert rows[2].split() == ["Swap:", *"---", "mirage"]


@pytest.mark.asyncio
async def test_a_workspace_with_no_machine_answers_alone():
    budget = MemoryBudget(32 << 20, lambda: 0)
    out, _, code = await run_with_memory(
        budget, free_of("-m", table=table_of(ids=[]))
    )
    assert code == 0
    assert out.splitlines()[0] == HEADER
    assert out.splitlines()[1].split() == [
        "Mem:",
        "32",
        "0",
        "32",
        "-",
        "-",
        "32",
    ]


@pytest.mark.asyncio
async def test_machine_picks_the_workspace():
    budget = MemoryBudget(32 << 20, lambda: 0)
    out, _, _ = await run_with_memory(
        budget,
        free_of("-m", "--machine", "mirage", table=table_of(resources())),
    )
    assert out.splitlines()[0] == HEADER
    assert out.splitlines()[1].split()[1] == "32"


@pytest.mark.asyncio
async def test_a_figure_a_machine_lacks_prints_a_dash():
    table = table_of(resources(shared=None, buffers=None, cached=None))
    out, _, _ = await free_of("--machine", "docker:a", table=table)
    assert out.splitlines()[1].split()[4:6] == ["-", "-"]


@pytest.mark.asyncio
async def test_machine_flag_narrows_to_one_and_drops_the_column():
    table = table_of(resources("docker:a"), resources("e2b:b"))
    out, _, _ = await free_of("--machine", "b", table=table)
    assert out == f"{HEADER}\n{MEM}\n{SWAP}\n"


@pytest.mark.asyncio
async def test_unknown_machine_is_refused():
    _, err, code = await free_of("--machine", "nosuch")
    assert err == "free: nosuch: no such machine\n"
    assert code == 1


@pytest.mark.asyncio
async def test_a_machine_that_does_not_answer_says_so():
    table = table_of(resources("docker:a"), ids=["docker:a", "e2b:down"])
    out, err, code = await free_of(table=table)
    assert "docker:a" in out and "e2b:down" not in out
    assert err == "free: e2b:down: machine did not answer\n"
    assert code == 1


@pytest.mark.parametrize(
    ("words", "said"),
    [
        (["-m", "-g"], "free: Multiple unit options don't make sense.\n"),
        (
            ["-s", "abc"],
            "free: seconds argument failed: 'abc': Invalid argument\n",
        ),
        (["-s", "0"], "free: seconds argument `0' is not positive number\n"),
        (["-c", "abc"], "free: failed to parse count argument: 'abc'\n"),
        (
            ["-c", "0"],
            "free: failed to parse count argument: '0': "
            "Numerical result out of range\n",
        ),
    ],
)
@pytest.mark.asyncio
async def test_bad_options_are_refused_in_procps_words(
    words: list[str], said: str
):
    _, err, code = await free_of(*words)
    assert err == said
    assert code == 1


@pytest.mark.asyncio
async def test_unknown_option_prints_the_usage_page():
    _, err, code = await free_of("-x")
    assert err.startswith("free: invalid option -- 'x'\n\n")
    assert code == 1
