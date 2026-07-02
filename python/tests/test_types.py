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

from mirage.types import Aggr, CommandSafeguard, FileStat, OnExceed, PathSpec


def test_filestat_defaults():
    fs = FileStat(name="foo.txt")
    assert fs.name == "foo.txt"
    assert fs.size is None
    assert fs.extra == {}


def test_filestat_immutable():
    fs = FileStat(name="foo.txt")
    with pytest.raises(ValidationError):
        fs.name = "bar.txt"


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


def test_pathspec_requires_resource_path():
    with pytest.raises(TypeError):
        PathSpec(virtual="/x.txt", directory="/")


def test_pathspec_display_prefers_raw_path():
    p = PathSpec(virtual="/data/a.txt",
                 directory="/data/",
                 resource_path="a.txt",
                 raw_path="../a.txt")
    assert p.display == "../a.txt"


def test_pathspec_display_falls_back_to_virtual():
    p = PathSpec(virtual="/data/a.txt",
                 directory="/data/",
                 resource_path="a.txt")
    assert p.display == "/data/a.txt"


def test_pathspec_dir_trims_resource_path():
    p = PathSpec(virtual="/data/sub/x.txt",
                 directory="/data/sub/",
                 resource_path="sub/x.txt",
                 pattern="*.txt")
    d = p.dir
    assert d.virtual == "/data/sub/"
    assert d.resource_path == "sub"
    assert d.pattern == "*.txt"


def test_pathspec_dir_at_mount_root():
    p = PathSpec(virtual="/data/x.txt",
                 directory="/data/",
                 resource_path="x.txt")
    assert p.dir.resource_path == ""


def test_pathspec_from_str_path_defaults_to_root_mounted():
    p = PathSpec.from_str_path("/a/b/c.txt")
    assert p.resource_path == "a/b/c.txt"
    assert p.directory == "/a/b/"


def test_pathspec_from_str_path_explicit_resource_path():
    p = PathSpec.from_str_path("/mnt/s3/data/x.json", "data/x.json")
    assert p.resource_path == "data/x.json"
