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

from collections.abc import AsyncIterator
from typing import Any

import pytest
import pytest_asyncio

from mirage.core.airtable.events import AirtableDeltaHook
from mirage.types import FileChangeKind, PathSpec
from tests.fixtures.airtable_account import BASES, TABLES, AirtableAccount

C, U, D, X = (
    FileChangeKind.CREATE,
    FileChangeKind.UPDATE,
    FileChangeKind.DELETE,
    FileChangeKind.UNKNOWN,
)
# The world integ/fixtures/airtable/events.json seeds: one base holding one
# table, and a page of two payloads.
ROADMAP = "appRoadmap0000001"
FEATURES_ID = "tblFeatures000001"
OPS = "appOps00000000001"
NOTES = "tblNotes000000001"
OTHER = "tblOther000000001"
BASE = f"/at/bases/Roadmap__{ROADMAP}"
FEATURES = f"{BASE}/Features__{FEATURES_ID}"


class World:
    """The account and the webhook its base already has.

    Args:
        account (AirtableAccount): the account.
        hook (str): the webhook on the Roadmap base.
    """

    def __init__(self, account: AirtableAccount, hook: str) -> None:
        self.account = account
        self.hook = hook

    async def push(self, payload: dict[str, Any], hook: str | None = None):
        await self.account.push(hook or self.hook, payload)

    async def calls(self) -> list[str]:
        """Each base listing and table listing asked, in order."""
        out = []
        for r in await self.account._listed():
            if r["route"] == BASES:
                out.append("bases")
            elif r["route"] == TABLES:
                out.append(f"tables {r['path'].split('/')[4]}")
        return out


@pytest_asyncio.fixture
async def world(airtable_origin: str) -> AsyncIterator[World]:
    account = AirtableAccount(airtable_origin)
    await account.reset(fixture="events")
    hook = await account.webhook(ROADMAP)
    await account.record_requests()
    yield World(account, hook)
    await account.run.close()


def _records(table_id: str = FEATURES_ID) -> dict[str, Any]:
    return {
        "changedTablesById": {
            table_id: {
                "changedRecordsById": {"rec00000000000001": {"current": {}}}
            }
        }
    }


def _root(vfs_path: str = "") -> PathSpec:
    virtual = f"/at/{vfs_path}" if vfs_path else "/at"
    return PathSpec(virtual=virtual, directory=virtual, vfs_path=vfs_path)


def _hook(world: World, **config: Any) -> AirtableDeltaHook:
    return AirtableDeltaHook(world.account.accessor(**config))


def _pairs(delta) -> list[tuple[FileChangeKind, str]]:
    return [(c.kind, c.path.virtual) for c in delta.changes]


@pytest.mark.asyncio
async def test_a_baseline_starts_at_the_present_and_each_ping_reads_on(
    world,
):
    await world.push(_records())
    hook = _hook(world)
    base = await hook.pull(_root(), None)
    assert base.changes == ()
    await world.push(_records())
    await world.push(_records())
    await world.push(
        {"changedTablesById": {FEATURES_ID: {"changedViewsById": {"v": {}}}}}
    )
    delta = await hook.pull(_root(), base.checkpoint)
    assert _pairs(delta) == [
        (U, f"{FEATURES}/records.jsonl"),
        (X, f"{FEATURES}/views"),
    ]
    again = await hook.pull(_root(), delta.checkpoint)
    assert again.changes == ()


@pytest.mark.asyncio
async def test_fields_and_tables_name_their_files(world):
    hook = _hook(world)
    base = await hook.pull(_root(), None)
    await world.push(
        {
            "changedTablesById": {
                FEATURES_ID: {
                    "changedFieldsById": {"fldNew00000000001": {"current": {}}}
                }
            },
            "createdTablesById": {
                NOTES: {"metadata": {"name": "Notes"}, "fieldsById": {}}
            },
        }
    )
    delta = await hook.pull(_root(), base.checkpoint)
    assert _pairs(delta) == [
        (C, f"{BASE}/Notes__{NOTES}/table.json"),
        (C, f"{BASE}/Notes__{NOTES}/records.jsonl"),
        (X, f"{BASE}/Notes__{NOTES}/views"),
        (U, f"{BASE}/base.json"),
        (U, f"{FEATURES}/table.json"),
        (U, f"{FEATURES}/records.jsonl"),
        (X, f"{FEATURES}/views"),
    ]
    await world.push(
        {
            "changedTablesById": {
                NOTES: {
                    "changedMetadata": {
                        "current": {"name": "Ideas"},
                        "previous": {"name": "Notes"},
                    }
                }
            }
        }
    )
    await world.push({"destroyedTableIds": [FEATURES_ID]})
    await world.push(_records(NOTES))
    delta = await hook.pull(_root(), delta.checkpoint)
    assert _pairs(delta) == [
        (X, f"{BASE}/Notes__{NOTES}"),
        (X, f"{BASE}/Ideas__{NOTES}"),
        (U, f"{BASE}/base.json"),
        (D, FEATURES),
        (U, f"{BASE}/Ideas__{NOTES}/records.jsonl"),
        (X, f"{BASE}/Ideas__{NOTES}/views"),
    ]
    assert (await world.calls()).count(f"tables {ROADMAP}") == 1


@pytest.mark.asyncio
async def test_lost_payloads_are_unknown_on_the_event_root(world):
    hook = _hook(world)
    base = await hook.pull(_root(), None)
    await world.push(_records())
    await world.push(_records())
    await world.account.expire(world.hook, 2)
    delta = await hook.pull(_root(), base.checkpoint)
    assert _pairs(delta)[0] == (X, "/at")
    await world.push({"error": True, "code": "INVALID_HOOK"})
    assert _pairs(await hook.pull(_root(), delta.checkpoint)) == [(X, "/at")]


@pytest.mark.asyncio
async def test_a_webhook_gone_is_lost_and_a_new_one_reads_from_its_start(
    world,
):
    hook = _hook(world)
    base = await hook.pull(_root(), None)
    await world.account.drop_webhook(ROADMAP, world.hook)
    made = await world.account.webhook(ROADMAP)
    await world.push(_records(), made)
    delta = await hook.pull(_root(), base.checkpoint)
    assert _pairs(delta) == [
        (X, "/at"),
        (U, f"{FEATURES}/records.jsonl"),
        (X, f"{FEATURES}/views"),
    ]


@pytest.mark.asyncio
async def test_a_new_webhook_whose_first_payloads_expired_is_lost(world):
    await world.push(_records())
    await world.push(_records())
    hook = _hook(world)
    base = await hook.pull(_root(), None)
    made = await world.account.webhook(ROADMAP)
    await world.push(_records(), made)
    await world.push(_records(), made)
    await world.account.expire(made, 2)
    delta = await hook.pull(_root(), base.checkpoint)
    assert _pairs(delta) == [
        (X, "/at"),
        (U, f"{FEATURES}/records.jsonl"),
        (X, f"{FEATURES}/views"),
    ]


@pytest.mark.asyncio
async def test_bases_come_and_go(world):
    hook = _hook(world)
    base = await hook.pull(_root(), None)
    await world.account.store(
        "DELETE FROM AirtableBase WHERE tenant = 'default' AND id = ?", ROADMAP
    )
    await world.account.store(
        "INSERT INTO AirtableBase (tenant, id, name, permissionLevel, seq) "
        "VALUES ('default', ?, 'Ops', 'create', 2)",
        OPS,
    )
    delta = await hook.pull(_root(), base.checkpoint)
    assert _pairs(delta) == [(X, f"/at/bases/Ops__{OPS}"), (D, BASE)]


@pytest.mark.asyncio
async def test_a_base_root_lists_no_bases(world):
    root = _root(f"bases/Roadmap__{ROADMAP}/Features__{FEATURES_ID}")
    hook = _hook(world)
    base = await hook.pull(root, None)
    await world.push(_records())
    await world.push(_records(OTHER))
    await world.account.store(
        "INSERT INTO AirtableTable "
        "(tenant, id, baseId, name, primaryFieldId, seq) "
        "VALUES ('default', ?, ?, 'Other', 'fldOther000000001', 2)",
        OTHER,
        ROADMAP,
    )
    await world.account.store(
        "INSERT INTO AirtableField (tenant, id, tableId, name, type, seq) "
        "VALUES ('default', 'fldOther000000001', ?, 'Name', "
        "'singleLineText', 2)",
        OTHER,
    )
    delta = await hook.pull(root, base.checkpoint)
    assert _pairs(delta) == [
        (U, f"{FEATURES}/records.jsonl"),
        (X, f"{FEATURES}/views"),
    ]
    assert "bases" not in await world.calls()


@pytest.mark.asyncio
async def test_a_base_the_mount_leaves_out_reads_nothing(world):
    hook = _hook(world, base_ids=[OPS])
    root = _root(f"bases/Roadmap__{ROADMAP}")
    base = await hook.pull(root, None)
    await world.push(_records())
    assert (await hook.pull(root, base.checkpoint)).changes == ()
    assert await world.calls() == []


@pytest.mark.asyncio
async def test_a_base_that_lost_payloads_names_its_tables_again(world):
    hook = _hook(world)
    base = await hook.pull(_root(), None)
    await world.push(
        {
            "changedTablesById": {
                FEATURES_ID: {
                    "changedMetadata": {"current": {"name": "Ideas"}}
                }
            }
        }
    )
    await world.account.expire(world.hook, 2)
    await world.account.store(
        "UPDATE AirtableTable SET name = 'Ideas' "
        "WHERE tenant = 'default' AND id = ?",
        FEATURES_ID,
    )
    delta = await hook.pull(_root(), base.checkpoint)
    assert _pairs(delta) == [(X, "/at")]
    await world.push(_records())
    assert _pairs(await hook.pull(_root(), delta.checkpoint)) == [
        (U, f"{BASE}/Ideas__{FEATURES_ID}/records.jsonl"),
        (X, f"{BASE}/Ideas__{FEATURES_ID}/views"),
    ]
