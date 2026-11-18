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

from mirage.commands.cli.builtin.ast_grep.engine import process
from mirage.commands.errors import UsageError

pytest.importorskip("wasmtime")


def test_parser_uses_the_room_available_for_each_file() -> None:
    ceiling = 32 * 1024**2
    options: dict[str, str | bool | None] = {
        "verb": "run",
        "language": "TypeScript",
        "path": "input.ts",
        "pattern": "return $X",
        "view": "auto",
        "directory": False,
        "files_only": True,
        "update": False,
    }
    line = b"export function f(x:number){return x+1}\n"
    dense = line * 6000
    assert process(options, line, ceiling // 2, ceiling)["count"] == 1
    assert process(options, dense, ceiling * 2, ceiling)["count"] == 1
    with pytest.raises(UsageError, match="parser resource limit exceeded"):
        process(options, dense, ceiling // 2, ceiling)
