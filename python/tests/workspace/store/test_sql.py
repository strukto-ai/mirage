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


import contextlib
from collections.abc import Callable, Iterator

import pytest

from mirage.execution.job.types import JobState
from mirage.execution.line.types import LineState
from mirage.execution.process.types import ProcessState
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.vfs.sql.driver import SqliteDriver
from mirage.vfs.sql.postgres import PostgresSqlDriver
from mirage.vfs.sql.types import SqlDriver
from mirage.workspace import Workspace
from mirage.workspace.store.sql import SqlWorkspaceStateStore
from tests.fixtures.postgres import ON_POSTGRES, fresh_database


@pytest.fixture(params=["sqlite", ON_POSTGRES])
def open_workspace(request, tmp_path) -> Iterator[Callable[[], Workspace]]:
    path = str(tmp_path / "state.db")
    with (
        fresh_database()
        if request.param == "postgres"
        else contextlib.nullcontext("")
    ) as dsn:

        def open_one() -> Workspace:
            driver: SqlDriver = (
                SqliteDriver(path)
                if request.param == "sqlite"
                else PostgresSqlDriver(dsn)
            )
            return Workspace(
                {"/m": (RAMVFS(), MountMode.WRITE)},
                mode=MountMode.WRITE,
                workspace_id="shared",
                session_id="s",
                store=SqlWorkspaceStateStore(driver, owns_driver=True),
                owns_store=True,
            )

        yield open_one


# Two daemons on one database share a workspace's execution plane: the
# one that does not hold the lease lists the lines, jobs and processes
# the holder runs and kills its job, and a workspace opened on the
# database later lists the lines that ended.
@pytest.mark.asyncio
async def test_the_execution_plane_lives_in_the_database(open_workspace):
    a, b = open_workspace(), open_workspace()
    try:
        pid = int((await a.shell("sleep 30 & echo $!", session_id="s")).stdout)
        [line] = await b.lines()
        assert (line.command, line.state) == (
            "sleep 30 & echo $!",
            LineState.EXITED,
        )
        [running] = await b.processes(state=ProcessState.RUNNING)
        assert running.pid == pid
        [job] = await b.jobs()
        assert (job.command, job.state) == ("sleep 30", JobState.RUNNING)
        assert await b.job_table.kill(1, "s", 15)
        assert (await b.job_table.wait(1, "s")).exit_code == 143
    finally:
        await a.close()
        await b.close()
    later = open_workspace()
    try:
        assert [line.command for line in await later.lines()] == [
            "sleep 30 & echo $!"
        ]
    finally:
        await later.close()
