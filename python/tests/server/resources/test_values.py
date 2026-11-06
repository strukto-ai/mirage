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

from mirage.resources.errors import ResourceError
from mirage.server.resources.types import Field, TypeTable
from mirage.server.resources.values import check_values, stores_of

TYPES: TypeTable = {
    "box": [
        Field(name="owner", type="string", secret=False, required=False),
        Field(name="token", type="string", secret=True, required=True),
        Field(name="tags", type="list", secret=False, required=False),
        Field(
            name="mode",
            type="string",
            secret=False,
            required=False,
            options=["a", "b"],
        ),
    ]
}


def refusal(given, kind="vfs", type="box", kept=frozenset()) -> str:
    with pytest.raises(ResourceError) as e:
        check_values(kind, type, given, TYPES, kept)
    return str(e.value)


def test_a_secret_is_sealed_and_a_store_pointer_stays_plain():
    checked = check_values(
        "vfs", "box", {"owner": "o", "token": "t", "mode": ""}, TYPES
    )
    assert checked.config == {"owner": "o"}
    assert checked.sealed == {"token": "t"}
    pointer = {"from": "aws", "ref": " gh ", "key": " token "}
    checked = check_values("vfs", "box", {"token": pointer}, TYPES)
    assert checked.config == {
        "token": {"from": "aws", "ref": "gh", "key": "token"}
    }
    assert checked.sealed == {}
    assert stores_of(checked.config) == ["aws"]


def test_a_value_its_field_cannot_take_is_refused():
    assert "must be a value or a secret store" in refusal(
        {"token": {"from": "strukto", "ref": "gh", "key": "token"}}
    )
    assert "tags must be a list of strings" in refusal(
        {"token": "t", "tags": "x"}
    )
    assert "mode must be one of a, b" in refusal({"token": "t", "mode": "c"})
    assert "box has no field nope" in refusal({"token": "t", "nope": 1})
    assert "type must be a vfs: box" in refusal({}, type="other")


def test_a_kept_secret_counts_as_given():
    assert "token is required" in refusal({"owner": "o"})
    checked = check_values(
        "vfs", "box", {"owner": "o"}, TYPES, frozenset({"token"})
    )
    assert checked.config == {"owner": "o"}
