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

import time

import pytest

from mirage.types import FileStat, FileType
from mirage.utils.errors import enoent
from mirage.workspace.executor.builtins.script import (handle_sleep,
                                                       parse_bash_args,
                                                       read_script_text)
from mirage.workspace.session import Session


def test_parse_bash_args_file_operand_ends_option_parsing():
    parsed = parse_bash_args(["run.sh", "-x", "a"])
    assert parsed.path == "run.sh"
    assert parsed.argv == ["-x", "a"]
    assert parsed.settings == ()


def test_parse_bash_args_double_dash_protects_a_flag_shaped_file():
    parsed = parse_bash_args(["--", "-weird.sh", "a"])
    assert parsed.path == "-weird.sh"
    assert parsed.argv == ["a"]


def test_parse_bash_args_single_dash_ends_option_parsing():
    parsed = parse_bash_args(["-", "run.sh"])
    assert parsed.path == "run.sh"


def test_parse_bash_args_clustered_c_keeps_set_options():
    parsed = parse_bash_args(["-xc", "echo hi", "name", "a"])
    assert parsed.script == "echo hi"
    assert parsed.argv == ["name", "a"]
    assert parsed.settings == (("xtrace", True), )


def test_parse_bash_args_maps_set_flags_to_options():
    parsed = parse_bash_args(["-eux", "run.sh"])
    assert parsed.path == "run.sh"
    assert parsed.settings == (("errexit", True), ("nounset", True), ("xtrace",
                                                                      True))


def test_parse_bash_args_last_sign_wins_within_one_invocation():
    parsed = parse_bash_args(["-e", "+e", "run.sh"])
    assert parsed.path == "run.sh"
    assert parsed.settings == (("errexit", True), ("errexit", False))


def test_parse_bash_args_dash_s_keeps_operands_positional():
    parsed = parse_bash_args(["-s", "A", "B"])
    assert parsed.path is None and parsed.script is None
    assert parsed.argv == ["A", "B"]


def test_parse_bash_args_applies_o_and_its_value():
    parsed = parse_bash_args(["-o", "pipefail", "run.sh"])
    assert parsed.path == "run.sh"
    assert parsed.settings == (("pipefail", True), )


def test_parse_bash_args_long_option_consumes_its_value():
    parsed = parse_bash_args(["--rcfile", "rc", "run.sh"])
    assert parsed.path == "run.sh"


def test_parse_bash_args_unsupported_short_option():
    assert parse_bash_args(["-Z"]).invalid == "-Z"


def test_parse_bash_args_unsupported_long_option():
    assert parse_bash_args(["--nosuch", "run.sh"]).invalid == "--nosuch"


def test_parse_bash_args_dash_c_needs_a_value():
    assert parse_bash_args(["-c"]).needs_value == "-c"


@pytest.mark.asyncio
async def test_sleep_missing_operand_exits_1():
    _, io, node = await handle_sleep([])
    assert io.exit_code == 1
    assert io.stderr == b"sleep: missing operand\n"
    assert node.exit_code == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "raw",
    ["abc", "-1", "inf", "Infinity", "nan", "NaN", "0x10", "1_0", "1e309", ""])
async def test_sleep_invalid_interval_exits_1(raw):
    _, io, node = await handle_sleep([raw])
    assert io.exit_code == 1
    assert io.stderr == f"sleep: invalid time interval '{raw}'\n".encode()
    assert node.exit_code == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("raw", ["0", "0.", ".01", "+0.01", "1e-3"])
async def test_sleep_valid_interval_exits_0(raw):
    _, io, node = await handle_sleep([raw])
    assert io.exit_code == 0
    assert not io.stderr
    assert node.exit_code == 0


@pytest.mark.asyncio
async def test_sleep_zero_returns_promptly():
    start = time.monotonic()
    _, io, _ = await handle_sleep(["0"])
    assert io.exit_code == 0
    assert time.monotonic() - start < 0.05


@pytest.mark.asyncio
async def test_read_script_text_reports_a_missing_file():
    session = Session(session_id="s", cwd="/")

    async def dispatch(op, path, **kwargs):
        raise enoent(path)

    with pytest.raises(FileNotFoundError):
        await read_script_text(dispatch, "/missing.sh", session.cwd)


@pytest.mark.asyncio
async def test_read_script_text_calls_a_directory_a_directory():
    session = Session(session_id="s", cwd="/")
    stat = FileStat(name="sub", path="/sub", type=FileType.DIRECTORY, size=0)

    async def dispatch(op, path, **kwargs):
        if op == "stat":
            return stat, None
        raise enoent(path)

    with pytest.raises(IsADirectoryError):
        await read_script_text(dispatch, "/sub", session.cwd)


@pytest.mark.asyncio
async def test_read_script_text_propagates_a_non_filesystem_failure():
    session = Session(session_id="s", cwd="/")

    async def dispatch(op, path, **kwargs):
        raise RuntimeError("token expired")

    with pytest.raises(RuntimeError, match="token expired"):
        await read_script_text(dispatch, "/script.sh", session.cwd)
