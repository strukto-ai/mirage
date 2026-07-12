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

from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.commands.builtin.mongodb import COMMANDS
from mirage.commands.errors import FindParseError
from mirage.core.mongodb.types import EntityKind
from mirage.resource.mongodb.config import MongoDBConfig
from mirage.types import PathSpec

MOUNT = "/mongo"


def _find_command():
    for fn in COMMANDS:
        for rc in getattr(fn, "_registered_commands", []):
            if rc.name == "find" and rc.filetype is None:
                return fn
    raise AssertionError("factory find not registered for mongodb")


def _spec(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual,
                    resource_path=virtual[len(MOUNT):].strip("/"))


async def _list_collections(_client, _database, kind=EntityKind.COLLECTION):
    if kind == EntityKind.COLLECTION:
        return ["orders", "users"]
    return []


@pytest.fixture(autouse=True)
def _fake_cluster():
    exists = {"new_callable": AsyncMock, "return_value": True}
    with patch("mirage.core.mongodb.readdir.list_databases",
               new_callable=AsyncMock, return_value=["appdb"]), \
         patch("mirage.core.mongodb.readdir.list_collections",
               side_effect=_list_collections), \
         patch("mirage.core.mongodb.readdir.database_exists", **exists), \
         patch("mirage.core.mongodb.readdir.entity_exists", **exists), \
         patch("mirage.core.mongodb.stat.database_exists", **exists), \
         patch("mirage.core.mongodb.stat.entity_exists", **exists), \
         patch("mirage.core.mongodb.stat.count_documents",
               new_callable=AsyncMock, return_value=2), \
         patch("mirage.core.mongodb.stat.is_view",
               new_callable=AsyncMock, return_value=False), \
         patch("mirage.core.mongodb.stat.get_indexes",
               new_callable=AsyncMock, return_value=[]):
        yield


async def _run(paths: list[PathSpec], *texts: str, **flags) -> list[str]:
    accessor = MongoDBAccessor(config=MongoDBConfig(
        uri="mongodb://localhost:27017"))
    find = _find_command()
    stdout, _io = await find(accessor,
                             paths,
                             *texts,
                             index=RAMIndexCacheStore(),
                             **flags)
    data = stdout if isinstance(stdout, bytes) else b""
    return data.decode().splitlines()


@pytest.mark.asyncio
async def test_plain_find_lists_synthetic_metadata_files():
    lines = await _run([_spec(MOUNT)])
    assert f"{MOUNT}/appdb/database.json" in lines
    assert f"{MOUNT}/appdb/collections/users/schema.json" in lines
    assert f"{MOUNT}/appdb/collections/users/documents.jsonl" in lines
    assert f"{MOUNT}/appdb/collections/orders" in lines
    assert f"{MOUNT}/appdb/views" in lines


@pytest.mark.asyncio
async def test_name_filters_documents_files():
    lines = await _run([_spec(MOUNT)], name="*.jsonl")
    assert lines == [
        f"{MOUNT}/appdb/collections/orders/documents.jsonl",
        f"{MOUNT}/appdb/collections/users/documents.jsonl",
    ]


@pytest.mark.asyncio
async def test_iname_is_case_insensitive():
    lines = await _run([_spec(MOUNT)], iname="SCHEMA.JSON")
    assert lines == [
        f"{MOUNT}/appdb/collections/orders/schema.json",
        f"{MOUNT}/appdb/collections/users/schema.json",
    ]


@pytest.mark.asyncio
async def test_type_d_uses_extension_hint():
    lines = await _run([_spec(MOUNT)], type="d")
    assert f"{MOUNT}/appdb/collections/users" in lines
    assert f"{MOUNT}/appdb/views" in lines
    assert all(not line.endswith((".json", ".jsonl")) for line in lines)


@pytest.mark.asyncio
async def test_type_f_selects_only_rendered_files():
    lines = await _run([_spec(MOUNT)], type="f")
    assert lines
    assert all(line.endswith((".json", ".jsonl")) for line in lines)


@pytest.mark.asyncio
async def test_maxdepth_limits_walk():
    lines = await _run([_spec(MOUNT)], maxdepth="1")
    assert lines == [MOUNT, f"{MOUNT}/appdb"]


@pytest.mark.asyncio
async def test_mindepth_drops_shallow_entries():
    lines = await _run([_spec(MOUNT)], mindepth="3")
    assert lines
    assert all(
        line.removeprefix(MOUNT).strip("/").count("/") >= 2 for line in lines)


@pytest.mark.asyncio
async def test_bare_word_operand_is_a_parse_error():
    # GNU find rejects a bare word in expression position; the bare-name
    # defaulting some KB wrappers do is deliberately not generic.
    with pytest.raises(FindParseError):
        await _run([_spec(MOUNT)], "database.json")


@pytest.mark.asyncio
async def test_negation_excludes_pattern():
    lines = await _run([_spec(MOUNT)], "!", "-name", "*.json*")
    assert f"{MOUNT}/appdb/collections" in lines
    assert all(".json" not in line for line in lines)


@pytest.mark.asyncio
async def test_multiple_start_points_walk_in_operand_order():
    lines = await _run([
        _spec(f"{MOUNT}/appdb/collections/users"),
        _spec(f"{MOUNT}/appdb/views"),
    ])
    assert f"{MOUNT}/appdb/collections/users/schema.json" in lines
    assert lines.index(f"{MOUNT}/appdb/collections/users") < lines.index(
        f"{MOUNT}/appdb/views")


@pytest.mark.asyncio
async def test_size_filter_excludes_sizeless_rendered_files():
    # -size applies to files only (GNU filters regular files by size);
    # Mongo's rendered files carry no size, so every file drops out and
    # directories pass through untouched.
    lines = await _run([_spec(MOUNT)], size="+1")
    assert lines
    assert all(not line.endswith((".json", ".jsonl")) for line in lines)


@pytest.mark.asyncio
async def test_glob_operand_expands_mid_path():
    pattern = PathSpec(virtual=f"{MOUNT}/*/collections",
                       directory=f"{MOUNT}/",
                       resource_path="*/collections",
                       pattern="collections",
                       resolved=False)
    lines = await _run([pattern])
    assert f"{MOUNT}/appdb/collections/users/documents.jsonl" in lines
    assert all("views" not in line for line in lines)
