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

from mirage.commands.cli.builtin.airtable.util import (
    find_table,
    json_object,
    one_operand,
    parse_json,
    scoped_base,
    stdin_text,
)
from mirage.commands.errors import UsageError
from mirage.core.airtable.config import AirtableConfig


def test_the_scope_admits_its_bases_and_refuses_the_rest():
    scoped = AirtableConfig(token="t", base_ids=["appA"])
    assert scoped_base(scoped, "appA") == "appA"
    assert scoped_base(AirtableConfig(token="t"), "appB") == "appB"
    with pytest.raises(PermissionError) as exc:
        scoped_base(scoped, "appB")
    assert str(exc.value) == "appB: Permission denied"


def test_a_table_is_found_by_id_before_name():
    tables = [{"id": "tblA", "name": "tblB"}, {"id": "tblB", "name": "B"}]
    assert find_table(tables, "tblB") == {"id": "tblB", "name": "B"}
    assert find_table(tables, "B") == {"id": "tblB", "name": "B"}
    assert find_table(tables, "tblA") == {"id": "tblA", "name": "tblB"}
    assert find_table(tables, "missing") is None


def test_json_is_strict_about_non_finite_numbers():
    assert parse_json('{"a": 1.5}') == {"a": 1.5}
    for text in ("NaN", "[Infinity]", '{"a": -Infinity}'):
        with pytest.raises(ValueError):
            parse_json(text)
    with pytest.raises(UsageError) as exc:
        json_object("--fields", "[]")
    assert exc.value.exit_code == 2


def test_one_operand_words_its_refusals_like_argparse():
    assert one_operand(["x"], "BASE") == "x"
    with pytest.raises(UsageError, match="are required: BASE"):
        one_operand([], "BASE")
    with pytest.raises(UsageError, match="unrecognized arguments: y z"):
        one_operand(["x", "y", "z"], "BASE")


@pytest.mark.asyncio
async def test_stdin_drops_a_leading_byte_order_mark():
    assert await stdin_text("﻿{}\n".encode()) == "{}\n"
    assert await stdin_text(b"caf\xc3\xa9") == "café"
