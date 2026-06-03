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
from pydantic import ValidationError

from mirage.commands.types import (CommandResult, FilePayload,
                                   RemoteCommandOptions)
from mirage.types import Aggr, CommandSafeguard, FileStat, OnExceed


def test_filestat_defaults():
    fs = FileStat(name="foo.txt")
    assert fs.name == "foo.txt"
    assert fs.size is None
    assert fs.extra == {}


def test_filestat_immutable():
    fs = FileStat(name="foo.txt")
    with pytest.raises(ValidationError):
        fs.name = "bar.txt"


def test_command_result_defaults():
    r = CommandResult(stdout="hello")
    assert r.stdout == "hello"
    assert r.output_files == {}


def test_command_result_with_files():
    r = CommandResult(stdout="done", output_files={"/out.csv": b"a,b"})
    assert r.output_files["/out.csv"] == b"a,b"


def test_file_payload_with_data():
    p = FilePayload(checksum="abc123", data=b"hello")
    assert p.checksum == "abc123"
    assert p.data == b"hello"


def test_file_payload_checksum_only():
    p = FilePayload(checksum="abc123")
    assert p.data is None


def test_remote_command_options_defaults():
    opts = RemoteCommandOptions()
    assert opts.max_file_size == "100MB"
    assert opts.cache == "enabled"


def test_remote_command_options_custom():
    opts = RemoteCommandOptions(max_file_size="500MB", cache="disabled")
    assert opts.max_file_size == "500MB"
    assert opts.cache == "disabled"


def test_remote_command_options_only_two_fields():
    opts = RemoteCommandOptions()
    assert opts.max_file_size == "100MB"
    assert opts.cache == "enabled"
    assert set(RemoteCommandOptions.model_fields.keys()) == {
        "max_file_size", "cache"
    }


def test_aggr_none_inputs_is_none():
    assert CommandSafeguard.aggr([None, None]) is None
    assert CommandSafeguard.aggr([]) is None


def test_aggr_keeps_single_safeguard():
    sg = CommandSafeguard(timeout_seconds=5, max_lines=100)
    out = CommandSafeguard.aggr([None, sg, None])
    assert out.timeout_seconds == 5
    assert out.max_lines == 100


def test_aggr_takes_smallest_positive_timeout():
    a = CommandSafeguard(timeout_seconds=10)
    b = CommandSafeguard(timeout_seconds=2)
    c = CommandSafeguard(timeout_seconds=None)
    out = CommandSafeguard.aggr([a, b, c])
    assert out.timeout_seconds == 2


def test_aggr_nonpositive_timeout_is_unbounded():
    a = CommandSafeguard(timeout_seconds=0)
    b = CommandSafeguard(timeout_seconds=5)
    out = CommandSafeguard.aggr([a, b])
    assert out.timeout_seconds == 5


def test_aggr_takes_smallest_caps():
    a = CommandSafeguard(max_bytes=1000, max_lines=None)
    b = CommandSafeguard(max_bytes=500, max_lines=50)
    out = CommandSafeguard.aggr([a, b])
    assert out.max_bytes == 500
    assert out.max_lines == 50


def test_aggr_error_beats_truncate():
    a = CommandSafeguard(on_exceed=OnExceed.TRUNCATE)
    b = CommandSafeguard(on_exceed=OnExceed.ERROR)
    out = CommandSafeguard.aggr([a, b])
    assert out.on_exceed is OnExceed.ERROR


def test_aggr_all_truncate_stays_truncate():
    a = CommandSafeguard(timeout_seconds=1)
    b = CommandSafeguard(timeout_seconds=2)
    out = CommandSafeguard.aggr([a, b])
    assert out.on_exceed is OnExceed.TRUNCATE


def test_every_field_declares_an_aggr_rule():
    for name, field in CommandSafeguard.model_fields.items():
        assert any(
            isinstance(m, Aggr)
            for m in field.metadata), (f"field {name!r} has no Aggr rule")
