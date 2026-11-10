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
from mirage.workspace.executor.builtins.pgrep.killall import handle_killall
from tests.fixtures.process_search import stop, text, with_jobs


@pytest.mark.asyncio
async def test_killall_signals_by_exact_name():
    table, jobs = await with_jobs("sleep 30")
    assert text(await handle_killall(table, ["killall", "slee"]))[2] == 1
    out, err, code = text(
        await handle_killall(table, ["killall", "-v", "sleep"])
    )
    assert out == ""
    assert err == f"Killed sleep({jobs[0].pid}) with signal 15\n"
    assert code == 0


@pytest.mark.asyncio
async def test_killall_says_which_name_found_nothing():
    table, jobs = await with_jobs("sleep 30")
    out, err, code = text(
        await handle_killall(table, ["killall", "sleep", "nosuch"])
    )
    assert out == ""
    assert err == "nosuch: no process found\n"
    assert code == 1
    await stop(table, jobs)


@pytest.mark.asyncio
async def test_killall_quiet_regexp_and_case():
    table, jobs = await with_jobs("sleep 30", "sleep 31")
    assert text(await handle_killall(table, ["killall", "-q", "nosuch"])) == (
        "",
        "",
        1,
    )
    assert (
        text(await handle_killall(table, ["killall", "-I", "SLEEP"]))[2] == 0
    )
    table2, jobs2 = await with_jobs("sleep 30")
    assert (
        text(await handle_killall(table2, ["killall", "-r", "sl.*"]))[2] == 0
    )
    await stop(table, jobs)
    await stop(table2, jobs2)


@pytest.mark.parametrize(
    ("words", "said"),
    [
        (
            ["-SIGNOPE", "x"],
            "NOPE: unknown signal; killall -l lists signals.\n",
        ),
        (
            ["-s", "NOPE", "x"],
            "NOPE: unknown signal; killall -l lists signals.\n",
        ),
        (["-r", "("], "killall: Bad regular expression: (\n"),
    ],
)
@pytest.mark.asyncio
async def test_killall_refusals(words: list[str], said: str):
    table = JobTable()
    _, err, code = text(await handle_killall(table, ["killall", *words]))
    assert err == said
    assert code == 1


@pytest.mark.asyncio
async def test_killall_lists_signals():
    out, _, code = text(await handle_killall(JobTable(), ["killall", "-l"]))
    assert out.startswith("HUP INT QUIT ILL")
    assert code == 0
