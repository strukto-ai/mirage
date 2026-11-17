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

from mirage.execution.process.types import ProcessTraits
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.executor.builtins.wrapper.wrapper import wrapper_traits


@pytest.mark.parametrize(
    ("name", "args", "at", "traits", "warned"),
    [
        (
            "nice",
            ["gcc"],
            0,
            ProcessTraits(niceness=10, wrappers=("nice",)),
            "",
        ),
        (
            "nice",
            ["-n", "5", "gcc"],
            2,
            ProcessTraits(niceness=5, wrappers=("nice", "-n", "5")),
            "",
        ),
        (
            "nice",
            ["-n", "-5", "gcc"],
            2,
            ProcessTraits(wrappers=("nice", "-n", "-5")),
            "nice: cannot set niceness: Permission denied\n",
        ),
        (
            "nohup",
            ["gcc"],
            0,
            ProcessTraits(ignores=frozenset({1}), wrappers=("nohup",)),
            "",
        ),
        (
            "setsid",
            ["-w", "gcc"],
            1,
            ProcessTraits(leads=True, wrappers=("setsid", "-w")),
            "",
        ),
        (
            "stdbuf",
            ["-oL", "gcc"],
            1,
            ProcessTraits(wrappers=("stdbuf", "-oL")),
            "",
        ),
    ],
)
def test_a_wrapper_changes_the_traits_of_its_program(
    name, args, at, traits, warned
):
    assert wrapper_traits(name, args, at, ProcessTraits()) == (traits, warned)


def test_nice_never_sets_the_niceness_past_19():
    worn, _ = wrapper_traits(
        "nice", ["-n", "9", "gcc"], 2, ProcessTraits(niceness=15)
    )
    assert worn.niceness == 19


@pytest.mark.asyncio
async def test_a_nohup_job_survives_a_hangup():
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC)
    try:
        io = await ws.shell(
            "nohup sleep 3 & p=$!; sleep 0.2; kill -HUP $p; sleep 0.2; "
            "kill -0 $p && echo alive; kill $p; wait $p; echo rc=$?"
        )
        assert await io.stdout_str() == "alive\nrc=143\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("line", "out"),
    [
        ("nice nice", "10\n"),
        ("nice sh -c nice", "10\n"),
        ("nice -n 3 sh -c 'nice -n 2 nice'", "5\n"),
        ("nohup nice -n 4 nice", "4\n"),
        ("nice -n 15 nice -n 9 nice", "19\n"),
    ],
)
async def test_nice_prints_the_niceness_its_wrappers_gave_it(line, out):
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC)
    try:
        assert await (await ws.shell(line)).stdout_str() == out
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_shell_s_inner_wrapper_leaves_the_job_alone():
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC)
    try:
        io = await ws.shell(
            "nice -n 0 sh -c 'nohup sleep 0; echo ready; sleep 3' & p=$!; "
            "sleep 0.3; kill -HUP $p; sleep 0.2; "
            "kill -0 $p 2>/dev/null && echo alive; wait $p; echo rc=$?"
        )
        assert await io.stdout_str() == "ready\nrc=129\n"
    finally:
        await ws.close()
