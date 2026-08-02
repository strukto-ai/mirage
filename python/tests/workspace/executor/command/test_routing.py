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

from mirage.types import PathSpec
from mirage.workspace.executor.command.routing import (merge_scopes,
                                                       path_flag_scopes)


def _path(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual,
                    resource_path="",
                    resolved=True)


def test_merge_scopes_keeps_operand_order_and_dedupes():
    a, b = _path("/m/a"), _path("/m/b")
    dup = _path("/m/a")
    merged = merge_scopes([a, b], [dup, _path("/m/c")])
    assert [p.virtual for p in merged] == ["/m/a", "/m/b", "/m/c"]


def test_path_flag_scopes_reads_path_valued_flags():
    scopes = path_flag_scopes("shuf", ["--output=/dst/out", "/src/in"], "/")
    assert [s.virtual for s in scopes] == ["/dst/out"]


def test_path_flag_scopes_unknown_command_is_empty():
    assert path_flag_scopes("nosuchcmd", ["-x", "/a"], "/") == []
