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
from mirage.shell.parse.parse import parse
from mirage.vfs.ram import RAMVFS
from mirage.workspace.workspace.history import history_entries

# Each pinned against Debian Bash 5.2.37, `bash --norc -i` with `set +H`.
CASES = [
    ("echo a\necho b; echo c\n", ["echo a", "echo b; echo c"]),
    ("for i in 1 2\ndo echo $i\ndone\n", ["for i in 1 2; do echo $i; done"]),
    (
        "if true\nthen\necho y\nelse\necho n\nfi\n",
        ["if true; then echo y; else echo n; fi"],
    ),
    ("f()\n{\n:\n}\n", ["f() { :; }"]),
    ("echo a |\ncat\ntrue &&\necho b\n", ["echo a | cat", "true && echo b"]),
    ("echo c \\\n  d\n", ["echo c   d"]),
    ('echo "q\nr" $(echo a\necho b)\n', ['echo "q\nr" $(echo a\necho b)']),
    ("case y in\ny)\necho y\n;;\nesac\n", ["case y in y) echo y; ;; esac"]),
    (
        "if (true)\nthen :\nfi\na=(1\n2)\n",
        ["if (true); then :; fi", "a=(1 2)"],
    ),
    (
        "cat <<A; echo after\nbody\nA\necho z\n",
        ["cat <<A; echo after\nbody\nA\n", "echo z"],
    ),
    (
        "if true; then cat <<A\nx\nA\nfi\n",
        ["if true; then cat <<A\nx\nA\n fi"],
    ),
    ("X=$(cat <<A\nx\nA\n)\n", ["X=$(cat <<A\nx\nA\n\n)"]),
    ("X=$(curl a \\\n  -H b)\n", ["X=$(curl a \\\n  -H b)"]),
    ("for i in 1\n# c\ndo :\ndone\n", ["for i in 1\ndo :; done"]),
    ("if true # why\nthen :; fi\n", ["if true # why\nthen :; fi"]),
    ("if true\n\nthen :\n   \nfi\n", ["if true;  then :;     fi"]),
    ("# note\n\n   \nfalse\n", ["# note", "   ", "false"]),
]


@pytest.mark.parametrize(("source", "expected"), CASES)
def test_history_entries(source: str, expected: list[str]) -> None:
    assert [e.text for e in history_entries(parse(source))] == expected


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
