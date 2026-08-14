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

from mirage.io.types import IOResult
from mirage.workspace.executor.builtins.history import (_parse_args,
                                                        handle_history)
from mirage.workspace.session import Session


class FakeMount:

    def __init__(self, io=None):
        self.io = io or IOResult()
        self.calls = []

    async def execute_cmd(self, name, paths, texts, flags, **kwargs):
        self.calls.append((name, texts, flags, kwargs))
        return b"1  ls\n", self.io


class FakeRegistry:

    def __init__(self, mount=None):
        self.mount = mount

    def try_mount_for(self, prefix):
        return self.mount


def session() -> Session:
    return Session(session_id="test")


def test_parse_args_collects_clustered_option_letters():
    flags, texts, error = _parse_args(["-c", "-w"])
    assert error is None
    assert flags == {"c": True, "w": True}
    assert texts == []


def test_parse_args_rejects_an_unknown_option_letter():
    flags, texts, error = _parse_args(["-x"])
    assert error == "history: -x: invalid option\n"
    assert (flags, texts) == ({}, [])


def test_parse_args_treats_a_digit_as_an_invalid_option_like_bash():
    _, _, error = _parse_args(["-1"])
    assert error == "history: -1: invalid option\n"


def test_parse_args_takes_the_d_offset_attached_to_its_token():
    flags, _, error = _parse_args(["-d3"])
    assert error is None
    assert flags["d"] == "3"


def test_parse_args_reads_an_attached_letter_as_the_d_offset_not_an_option():
    flags, _, error = _parse_args(["-dc"])
    assert error is None
    assert flags == {"d": "c"}


def test_parse_args_takes_the_next_token_as_the_d_offset_when_detached():
    flags, _, error = _parse_args(["-d", "7"])
    assert error is None
    assert flags["d"] == "7"


def test_parse_args_requires_an_argument_for_a_trailing_d():
    _, _, error = _parse_args(["-d"])
    assert error == "history: -d: option requires an argument\n"


def test_parse_args_stops_option_parsing_at_the_first_operand():
    flags, texts, error = _parse_args(["-s", "rm", "-rf"])
    assert error is None
    assert flags == {"s": True}
    assert texts == ["rm", "-rf"]


def test_parse_args_stops_option_parsing_at_a_double_dash():
    flags, texts, error = _parse_args(["--", "-c"])
    assert error is None
    assert flags == {}
    assert texts == ["-c"]


def test_parse_args_reads_a_bare_dash_as_an_operand():
    _, texts, error = _parse_args(["-"])
    assert error is None
    assert texts == ["-"]


@pytest.mark.asyncio
async def test_history_reports_a_usage_error_with_status_2():
    _, io, node = await handle_history(FakeRegistry(FakeMount()), ["-x"],
                                       session())
    assert io.exit_code == 2
    assert node.exit_code == 2
    assert io.stderr.startswith(b"history: -x: invalid option\n")
    assert b"history: usage: history [-c]" in io.stderr


@pytest.mark.asyncio
async def test_history_reports_when_the_workspace_has_no_history_mount():
    _, io, _ = await handle_history(FakeRegistry(None), [], session())
    assert io.exit_code == 1
    assert io.stderr == b"history: not enabled for this workspace\n"


@pytest.mark.asyncio
async def test_history_routes_flags_and_operands_to_the_view_mount():
    mount = FakeMount()
    stream, io, node = await handle_history(FakeRegistry(mount),
                                            ["-s", "echo hi"], session())
    name, texts, flags, kwargs = mount.calls[0]
    assert name == "history"
    assert texts == ["echo hi"]
    assert flags == {"s": True}
    assert kwargs["cwd"] == "/"
    assert kwargs["session_id"] == "test"
    assert stream == b"1  ls\n"
    assert io.exit_code == 0
    assert node.command == "history"


@pytest.mark.asyncio
async def test_history_resolves_the_mounts_stderr_before_building_the_node():
    mount = FakeMount(IOResult(exit_code=1, stderr=b"history: boom\n"))
    _, _, node = await handle_history(FakeRegistry(mount), [], session())
    assert node.stderr == b"history: boom\n"
    assert node.exit_code == 1
