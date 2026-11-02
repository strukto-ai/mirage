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

from mirage import MountMode, Workspace
from mirage.policy import Deny, ExecuteResultContext, Policy
from mirage.vfs.ram import RAMVFS


class _DenyOutput(Policy):
    async def post_execute(self, ctx: ExecuteResultContext) -> Deny:
        return Deny(reason="output withheld")


def _workspace() -> Workspace:
    return Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)


@pytest.mark.asyncio
async def test_records_each_command_read_with_what_it_wrote() -> None:
    ws = _workspace()
    try:
        io = await ws.shell(
            "echo a\nfor i in 1 2\ndo echo $i\ndone\n# done\nfalse\n"
        )
        assert await io.stdout_str() == "a\n1\n2\n"
        history = await ws.history()
        assert [
            e["command"]
            if e["type"] == "command"
            else [e["stdout"], e["exit_code"]]
            for e in history
        ] == [
            "echo a",
            ["a\n", 0],
            "for i in 1 2; do echo $i; done",
            ["1\n2\n", 0],
            "# done",
            ["", 0],
            "false",
            ["", 1],
        ]
        commands = [e for e in history if e["type"] == "command"]
        results = [e for e in history if e["type"] == "result"]
        assert [e["parent"] for e in results] == [e["id"] for e in commands]
        assert len({e["id"] for e in commands}) == 4
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_lists_each_in_history_and_reads_no_further_than_an_exit() -> (
    None
):
    ws = _workspace()
    try:
        await ws.shell("echo a\nexit 3\necho b\n")
        io = await ws.shell("history")
        assert await io.stdout_str() == "1  echo a\n2  exit 3\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_records_a_line_it_refuses_as_typed() -> None:
    ws = _workspace()
    try:
        await ws.shell("echo a\nif then\n")
        history = await ws.history()
        assert [e["command"] for e in history if e["type"] == "command"] == [
            "echo a",
            "if then",
        ]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_records_a_line_of_one_command_whole() -> None:
    ws = _workspace()
    try:
        await ws.shell("cat <<A\nx\nA\n")
        history = await ws.history()
        assert [e.get("command", e.get("stdout")) for e in history] == [
            "cat <<A\nx\nA\n",
            "x\n",
        ]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_records_a_line_whole_under_a_post_execute_policy() -> None:
    ws = _workspace()
    try:
        ws.policies.add(_DenyOutput())
        await ws.shell("echo secret\necho done\n")
        history = await ws.history()
        assert [e.get("command", e.get("stdout")) for e in history] == [
            "echo secret\necho done\n",
            "",
        ]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_records_the_commands_read_again_after_the_parser_changes() -> (
    None
):
    ws = _workspace()
    try:
        await ws.shell("shopt -s extglob\necho a\necho b\n")
        history = await ws.history()
        assert [e.get("command", e.get("stdout")) for e in history] == [
            "shopt -s extglob",
            "",
            "echo a",
            "a\n",
            "echo b",
            "b\n",
        ]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_records_each_comment_of_a_line_of_comments() -> None:
    ws = _workspace()
    try:
        await ws.shell("# first\n# second\n")
        history = await ws.history()
        assert [e["command"] for e in history if e["type"] == "command"] == [
            "# first",
            "# second",
        ]
    finally:
        await ws.close()
