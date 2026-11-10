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
from mirage.workspace.executor.builtins.pgrep.pidof import handle_pidof
from tests.fixtures.process_search import stop, text, with_jobs


@pytest.mark.asyncio
async def test_pidof_prints_newest_first_on_one_line():
    table, jobs = await with_jobs("sleep 30", "sleep 31")
    out, _, code = text(await handle_pidof(table, ["pidof", "sleep"]))
    assert out == f"{jobs[1].pid} {jobs[0].pid}\n"
    assert code == 0
    single, _, _ = text(await handle_pidof(table, ["pidof", "-s", "sleep"]))
    assert single == f"{jobs[1].pid}\n"
    joined, _, _ = text(await handle_pidof(table, ["pidof", "-d,", "sleep"]))
    assert joined == f"{jobs[1].pid},{jobs[0].pid}\n"
    await stop(table, jobs)


@pytest.mark.asyncio
async def test_pidof_finding_nothing_or_a_bad_option_says_nothing():
    table = JobTable()
    assert text(await handle_pidof(table, ["pidof", "nosuch"])) == ("", "", 1)
    assert text(await handle_pidof(table, ["pidof", "--foo"])) == ("", "", 1)
    assert text(await handle_pidof(table, ["pidof"])) == ("", "", 1)
