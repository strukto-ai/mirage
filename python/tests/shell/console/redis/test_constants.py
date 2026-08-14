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

from pathlib import Path

from mirage.shell.console.redis.constants import APPEND_LUA, BLOCK_MS

TS_LUA = (Path(__file__).parents[4].parent / "typescript" / "packages" /
          "node" / "src" / "shell" / "console" / "redis" / "append.lua")


def test_append_script_loads_from_the_lua_file():
    assert "INCR" in APPEND_LUA
    assert "XADD" in APPEND_LUA
    assert "'-0'" in APPEND_LUA
    # The ending flag and the TTL refresh both live in the script, so
    # they stay atomic with the append itself.
    assert "EXISTS" in APPEND_LUA
    assert "EXPIRE" in APPEND_LUA


def test_block_interval_is_short():
    """Close is only noticed between rounds, so a round must be short."""
    assert 0 < BLOCK_MS <= 1000


def test_lua_is_byte_identical_to_the_typescript_copy():
    """One wire schema, two copies: the two files must never drift."""
    assert APPEND_LUA == TS_LUA.read_text(encoding="utf-8")
