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

from mirage.execution.job import JobTable
from mirage.workspace.executor.builtins.pgrep.pgrep import (
    handle_pgrep,
    handle_pkill,
)
from tests.fixtures.process_search import stop, text, with_jobs


@pytest.mark.asyncio
async def test_pgrep_finds_by_name():
    table, jobs = await with_jobs("sleep 30", "cat big")
    out, _, code = text(await handle_pgrep(table, ["pgrep", "sleep"]))
    assert out == f"{jobs[0].pid}\n"
    assert code == 0
    await stop(table, jobs)


@pytest.mark.asyncio
async def test_pgrep_name_is_a_regular_expression_and_full_reads_arguments():
    table, jobs = await with_jobs("sleep 30")
    assert text(await handle_pgrep(table, ["pgrep", "sl.*p"]))[2] == 0
    assert text(await handle_pgrep(table, ["pgrep", "30"]))[2] == 1
    assert text(await handle_pgrep(table, ["pgrep", "-f", "30"]))[2] == 0
    await stop(table, jobs)


@pytest.mark.asyncio
async def test_pgrep_options_may_follow_the_pattern():
    table, jobs = await with_jobs("sleep 30")
    assert (
        text(await handle_pgrep(table, ["pgrep", "sleep", "-c"]))[0] == "1\n"
    )
    await stop(table, jobs)


@pytest.mark.asyncio
async def test_pgrep_counts_lists_and_joins():
    table, jobs = await with_jobs("sleep 30", "sleep 31")
    first, second = jobs[0].pid, jobs[1].pid
    assert (
        text(await handle_pgrep(table, ["pgrep", "-c", "sleep"]))[0] == "2\n"
    )
    assert text(await handle_pgrep(table, ["pgrep", "-l", "sleep"]))[0] == (
        f"{first} sleep\n{second} sleep\n"
    )
    assert text(await handle_pgrep(table, ["pgrep", "-a", "sleep"]))[0] == (
        f"{first} sleep 30\n{second} sleep 31\n"
    )
    assert text(await handle_pgrep(table, ["pgrep", "-d,", "sleep"]))[0] == (
        f"{first},{second}\n"
    )
    assert text(await handle_pgrep(table, ["pgrep", "-n", "sleep"]))[0] == (
        f"{second}\n"
    )
    assert text(await handle_pgrep(table, ["pgrep", "-o", "sleep"]))[0] == (
        f"{first}\n"
    )
    await stop(table, jobs)


@pytest.mark.asyncio
async def test_pgrep_exact_case_and_inverse():
    table, jobs = await with_jobs("sleep 30")
    assert text(await handle_pgrep(table, ["pgrep", "-x", "slee"]))[2] == 1
    assert text(await handle_pgrep(table, ["pgrep", "-x", "sleep"]))[2] == 0
    assert text(await handle_pgrep(table, ["pgrep", "-i", "SLEEP"]))[2] == 0
    assert text(await handle_pgrep(table, ["pgrep", "-v", "sleep"]))[2] == 1
    await stop(table, jobs)


@pytest.mark.parametrize(
    ("words", "said", "status"),
    [
        (
            [],
            "pgrep: no matching criteria specified\n"
            "Try `pgrep --help' for more information.\n",
            2,
        ),
        (
            ["a", "b"],
            "pgrep: only one pattern can be provided\n"
            "Try `pgrep --help' for more information.\n",
            2,
        ),
        (["-P", "abc"], "pgrep: not a number: abc\n", 2),
        (["("], "pgrep: regex error: Unmatched ( or \\(\n", 2),
    ],
)
@pytest.mark.asyncio
async def test_pgrep_refusals(words: list[str], said: str, status: int):
    table = JobTable()
    _, err, code = text(await handle_pgrep(table, ["pgrep", *words]))
    assert err == said
    assert code == status


@pytest.mark.asyncio
async def test_pgrep_warns_of_a_name_too_long_to_match():
    table = JobTable()
    _, err, code = text(
        await handle_pgrep(table, ["pgrep", "averyveryverylongname"])
    )
    assert "longer than 15 characters" in err
    assert code == 1


@pytest.mark.asyncio
async def test_pkill_signals_what_it_finds():
    table, jobs = await with_jobs("sleep 30", "cat big")
    out, _, code = text(await handle_pkill(table, ["pkill", "-e", "sleep"]))
    assert out == f"sleep killed (pid {jobs[0].pid})\n"
    assert code == 0
    finished = await table.wait(jobs[0].id)
    assert finished.exit_code == 143
    await stop(table, jobs[1:])


@pytest.mark.asyncio
async def test_pkill_takes_a_signal_first():
    table, jobs = await with_jobs("sleep 30")
    assert text(await handle_pkill(table, ["pkill", "-KILL", "sleep"]))[2] == 0
    finished = await table.wait(jobs[0].id)
    assert finished.exit_code == 137


@pytest.mark.asyncio
async def test_pkill_finding_nothing_is_1():
    table = JobTable()
    assert text(await handle_pkill(table, ["pkill", "nosuch"]))[2] == 1


@pytest.mark.asyncio
async def test_pkill_reads_a_bad_signal_as_an_option():
    table = JobTable()
    _, err, code = text(await handle_pkill(table, ["pkill", "-NOPE", "x"]))
    assert err.startswith("pkill: invalid option -- 'N'\n")
    assert code == 2
