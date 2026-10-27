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

from mirage.commands.builtin.generic.archive.extract import extract_dest
from mirage.types import PathSpec


def test_extract_dest_prefers_the_explicit_operand():
    explicit = PathSpec.from_str_path("/work/out")
    cwd = PathSpec.from_str_path("/elsewhere")
    assert extract_dest(explicit, cwd) == "/work/out"


def test_extract_dest_falls_back_to_the_virtual_cwd():
    cwd = PathSpec(virtual="/work/sub", directory="/work/sub", vfs_path="sub")
    assert extract_dest(None, cwd) == "/work/sub"


def test_extract_dest_string_cwd_defaults_to_root():
    assert extract_dest(None, "") == "/"
    assert extract_dest(None, "/w") == "/w"
