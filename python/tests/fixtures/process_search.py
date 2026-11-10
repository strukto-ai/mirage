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

from mirage.execution.job import JobTable
from tests.fixtures.job_runners import submit_pending


async def with_jobs(*commands: str) -> tuple[JobTable, list]:
    table = JobTable()
    return table, [
        await submit_pending(table, command=command) for command in commands
    ]


async def stop(table: JobTable, jobs: list) -> None:
    for job in jobs:
        await table.kill(job.id)


def text(result) -> tuple[str, str, int]:
    out, io, _ = result
    return (out or b"").decode(), (io.stderr or b"").decode(), io.exit_code
