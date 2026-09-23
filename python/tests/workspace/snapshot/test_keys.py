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

import re
from enum import StrEnum
from pathlib import Path

import pytest

from mirage.workspace.snapshot import keys

REPO_ROOT = Path(__file__).resolve().parents[4]
KEYS_TS = (REPO_ROOT / "typescript" / "packages" / "core" / "src" /
           "workspace" / "snapshot" / "keys.ts")

# These five have a typescript twin in `keys.ts`; the rest of the module
# is spelled as literals over there, so only these can be diffed.
SHARED = ["StateKey", "MountKey", "CacheKey", "JobKey", "VFSStateKey"]


def _typescript_tables() -> dict[str, dict[str, str]]:
    source = KEYS_TS.read_text()
    tables: dict[str, dict[str, str]] = {}
    pattern = r"export const (\w+) = Object\.freeze\(\{(.*?)\}\s*as const\)"
    for name, body in re.findall(pattern, source, re.DOTALL):
        tables[name] = dict(re.findall(r"(\w+): '([^']*)'", body))
    return tables


@pytest.mark.parametrize("name", SHARED)
def test_shared_tables_match_typescript(name: str):
    """A snapshot key is a wire name, so a one-sided rename breaks restore."""
    table = _typescript_tables()[name]
    enum: type[StrEnum] = getattr(keys, name)
    assert {member.name: member.value for member in enum} == table


def test_every_key_is_a_lowercase_wire_name():
    enums = [
        value for value in vars(keys).values() if isinstance(value, type)
        and issubclass(value, StrEnum) and value is not StrEnum
    ]
    assert len(enums) == 9
    for enum in enums:
        for member in enum:
            assert member.value == member.name.lower()
