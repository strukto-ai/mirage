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
from mirage.commands.config import CommandOpts
from mirage.core.mongodb.types import EntityKind
from mirage.io.types import materialize
from mirage.types import PathSpec
from mirage.vfs.mongodb import MongoDBVFS
from mirage.vfs.mongodb.config import MongoDBConfig
from tests.fixtures.vfs_io import io_for

MOUNT = "/mongo"


def _find_command():
    for fn in COMMANDS:
        for rc in getattr(fn, "_registered_commands", []):
            if rc.name == "find" and rc.filetype is None:
                return fn
    raise AssertionError("factory find not registered for mongodb")


def _spec(virtual: str) -> PathSpec:
    return PathSpec(
        virtual=virtual,
        directory=virtual,
        vfs_path=virtual[len(MOUNT) :].strip("/"),
    )


async def _list_collections(_client, _database, kind=EntityKind.COLLECTION):
    if kind == EntityKind.COLLECTION:
        return ["orders", "users"]
    return []


@pytest.fixture(autouse=True)
def _fake_cluster():
    exists = {"new_callable": AsyncMock, "return_value": True}
    with (
        patch(
            "mirage.core.mongodb.readdir.list_databases",
            new_callable=AsyncMock,
            return_value=["appdb"],
        ),
        patch(
            "mirage.core.mongodb.readdir.list_collections",
            side_effect=_list_collections,
        ),
        patch("mirage.core.mongodb.readdir.database_exists", **exists),
        patch("mirage.core.mongodb.readdir.entity_exists", **exists),
        patch("mirage.core.mongodb.readdir.database_exists", **exists),
        patch("mirage.core.mongodb.readdir.entity_exists", **exists),
        patch(
            "mirage.core.mongodb.client.count_documents",
            new_callable=AsyncMock,
            return_value=2,
        ),
        patch(
            "mirage.core.mongodb.client.is_view",
            new_callable=AsyncMock,
            return_value=False,
        ),
        patch(
            "mirage.core.mongodb.client.get_indexes",
            new_callable=AsyncMock,
            return_value=[],
        ),
    ):
        yield


async def _run(paths: list[PathSpec], *texts: str, **flags) -> list[str]:
    accessor = MongoDBAccessor(
        config=MongoDBConfig(uri="mongodb://localhost:27017")
    )
    find = _find_command()
    stdout, _io = await find(
        accessor,
        paths,
        list(texts),
        CommandOpts(
            io=io_for(MongoDBVFS, accessor),
            index=RAMIndexCacheStore(),
            flags={**flags},
        ),
    )
    data = await materialize(stdout)
    return data.decode().splitlines()


@pytest.mark.asyncio
async def test_sizeless_rendered_files_count_as_size_zero():
    # Mongo's rendered files carry no size, so they count as size 0 for
    # -size (what find sees over FUSE, which reports 0 before a file is
    # opened), while a directory is DIR_SIZE bytes: +1 keeps only the
    # directories and -1k only the files.
    assert await _run([_spec(MOUNT)], size="+1") == await _run(
        [_spec(MOUNT)], type="d"
    )
    assert await _run([_spec(MOUNT)], size="-1k") == await _run(
        [_spec(MOUNT)], type="f"
    )


@pytest.mark.asyncio
async def test_glob_operand_expands_mid_path():
    pattern = PathSpec(
        virtual=f"{MOUNT}/*/collections",
        directory=f"{MOUNT}/",
        vfs_path="*/collections",
        pattern="collections",
        resolved=False,
    )
    lines = await _run([pattern])
    assert f"{MOUNT}/appdb/collections/users/documents.jsonl" in lines
    assert all("views" not in line for line in lines)
