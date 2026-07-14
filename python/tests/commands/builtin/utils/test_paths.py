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

from mirage.commands.builtin.utils.paths import default_paths, resolve_script
from mirage.types import PathSpec


def _spec(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual,
                    resource_path=virtual.strip("/"))


def test_resolve_script_absolute_is_normalized():
    spec = resolve_script("/data/../data/run.py", _spec("/cwd"))
    assert spec.virtual == "/data/run.py"
    assert spec.resource_path == "data/run.py"
    assert spec.directory == "/data/"
    assert spec.resolved is True


def test_resolve_script_relative_joins_cwd():
    spec = resolve_script("sub/run.mjs", _spec("/data"))
    assert spec.virtual == "/data/sub/run.mjs"
    assert spec.directory == "/data/sub/"


def test_resolve_script_without_cwd_resolves_against_root():
    spec = resolve_script("run.py", None)
    assert spec.virtual == "/run.py"
    assert spec.directory == "/"


def test_non_empty_paths_pass_through():
    operands = [_spec("/mnt/a"), _spec("/mnt/b")]
    assert default_paths(operands, _spec("/cwd")) == operands


def test_empty_paths_fall_back_to_cwd():
    cwd = _spec("/cwd")
    assert default_paths([], cwd) == [cwd]


def test_empty_paths_without_cwd_default_to_root():
    result = default_paths([], None)
    assert len(result) == 1
    assert result[0].virtual == "/"
    assert result[0].resource_path == ""
