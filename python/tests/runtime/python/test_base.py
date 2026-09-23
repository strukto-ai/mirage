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

from mirage import RAMVFS, MountMode, Workspace
from mirage.runtime.python.base import PythonRuntime
from mirage.runtime.types import RunArgs, RunResult


class ProcessRuntime(PythonRuntime):
    name = "custom-process"
    runs = 0

    async def run(self, args: RunArgs) -> RunResult:
        self.runs += 1
        return RunResult(stdout=b"unexpected execution",
                         stderr=None,
                         exit_code=0)


@pytest.mark.asyncio
@pytest.mark.parametrize("mode",
                         [MountMode.READ, MountMode.WRITE, MountMode.EXEC])
async def test_custom_process_version_never_executes_code(mode):
    runtime = ProcessRuntime()
    assert runtime.reach == "process"
    ws = Workspace({"/": RAMVFS()}, mode=mode, runtimes=[runtime, "workspace"])
    try:
        for line in ["python --version", "python3 -V", "python -VV"]:
            io = await ws.shell(line, env={"PYTHONPATH": "/startup"})
            assert io.exit_code == 1
            assert await io.stdout_str() == ""
            assert await io.stderr_str(
            ) == "custom-process: version information unavailable\n"
            assert runtime.runs == 0
    finally:
        await ws.close()
