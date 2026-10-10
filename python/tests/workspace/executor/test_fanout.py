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

from dataclasses import replace

import pytest

from mirage.types import HiddenPaths, MountMode, PathSpec, Visibility
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.executor.fanout import _should_fan_out


def _nested() -> Workspace:
    return Workspace(
        {"/base": RAMVFS(), "/base/inner": RAMVFS(), "/other": RAMVFS()},
        mode=MountMode.WRITE,
    )


@pytest.mark.parametrize(
    "cmd, flags, expected",
    [
        ("find", {}, True),
        ("du", {}, True),
        ("du", {"one_file_system": True}, False),
        ("ls", {}, False),
        ("ls", {"recursive": True}, True),
        ("grep", {}, False),
        ("grep", {"r": True}, True),
        ("cat", {}, False),
    ],
)
def test_a_walk_fans_out_over_a_nested_mount(cmd, flags, expected):
    ws = _nested()
    path = PathSpec.from_str_path("/base")
    assert _should_fan_out(cmd, [path], flags, ws._registry) is expected


def test_no_nested_mount_and_a_refused_operand_stay_single():
    ws = _nested()
    other = PathSpec.from_str_path("/other")
    assert not _should_fan_out("find", [other], {}, ws._registry)
    refused = replace(PathSpec.from_str_path("/base"), walk_error="ENOENT")
    assert not _should_fan_out("find", [refused], {}, ws._registry)


@pytest.mark.asyncio
@pytest.mark.parametrize("line", ["find /base", "du /base", "ls -R /base"])
async def test_a_hidden_mount_does_not_bound_the_walk(line):
    ws = Workspace(
        {
            "/base": RAMVFS(),
            "/base/inner": RAMVFS(),
            "/base/seen": RAMVFS(),
        },
        mode=MountMode.WRITE,
    )
    ws.create_session("agent").visibility = Visibility(
        paths=HiddenPaths(paths=("/base/inner",))
    )
    try:
        result = await ws.shell(line, session_id="agent")
        assert result.exit_code == 0
        assert b"inner" not in await result.materialize_stdout()
        assert result.producer is not None
        assert result.producer.prefixes == ("/base/", "/base/seen/")
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,expected",
    [
        ("find /base -type f", b"/base/inner/g\n/base/top\n"),
        ("du -s /base", b"5\t/base\n"),
        ("du -s /base/inner /other", b"3\t/base/inner\n1\t/other\n"),
    ],
)
async def test_a_nested_mount_is_walked_through_the_ops(line, expected):
    ws = Workspace(
        {"/base": RAMVFS(), "/base/inner": RAMVFS(), "/other": RAMVFS()},
        mode=MountMode.WRITE,
    )
    try:
        await ws.shell(
            "printf ab > /base/top; printf abc > /base/inner/g;"
            " printf a > /other/h"
        )
        result = await ws.shell(line)
        assert await result.materialize_stdout() == expected
        assert result.exit_code == 0
    finally:
        await ws.close()
