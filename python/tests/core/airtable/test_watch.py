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

from typing import Any

import pytest

from mirage.accessor.airtable import AirtableAccessor
from mirage.core.airtable.config import AirtableConfig
from mirage.core.airtable.errors import AirtableAPIError
from mirage.core.airtable.watch import AirtableDeltaHook
from mirage.types import FileChangeKind, PathSpec

C, U, D, X = (
    FileChangeKind.CREATE,
    FileChangeKind.UPDATE,
    FileChangeKind.DELETE,
    FileChangeKind.UNKNOWN,
)
BASE = "/at/bases/Roadmap__appA"
FEATURES = f"{BASE}/Features__tblF"


class FakeAirtable:
    """Bases, their schemas, and each webhook's payloads, numbered from
    1 and kept from ``oldest`` on, served two to a page."""

    def __init__(self) -> None:
        self.bases = [{"id": "appA", "name": "Roadmap"}]
        self.tables = {"appA": [{"id": "tblF", "name": "Features"}]}
        self.hooks: dict[str, dict[str, list[dict[str, Any]]]] = {
            "appA": {"achH": []}
        }
        self.oldest = 1
        self.calls: list[str] = []

    async def list_bases(self, accessor):
        self.calls.append("bases")
        return list(self.bases)

    async def list_tables(self, accessor, base_id):
        self.calls.append(f"tables {base_id}")
        return list(self.tables[base_id])

    async def list_webhooks(self, accessor, base_id):
        return [
            {"id": hook_id, "cursorForNextPayload": len(log) + 1}
            for hook_id, log in self.hooks[base_id].items()
        ]

    async def webhook_payloads(self, accessor, base_id, hook_id, cursor):
        log = self.hooks[base_id].get(hook_id)
        if log is None:
            raise AirtableAPIError("not found", status=404)
        start = max(cursor or 1, self.oldest)
        page = log[start - 1 : start + 1]
        return {
            "payloads": page,
            "cursor": start + len(page),
            "mightHaveMore": start + len(page) <= len(log),
        }

    def push(self, payload: dict[str, Any], hook_id: str = "achH") -> None:
        self.hooks["appA"][hook_id].append(payload)


def _records(table_id: str = "tblF") -> dict[str, Any]:
    return {
        "changedTablesById": {
            table_id: {"changedRecordsById": {"rec1": {"current": {}}}}
        }
    }


def _root(vfs_path: str = "") -> PathSpec:
    virtual = f"/at/{vfs_path}" if vfs_path else "/at"
    return PathSpec(virtual=virtual, directory=virtual, vfs_path=vfs_path)


@pytest.fixture
def fake(monkeypatch) -> FakeAirtable:
    fake = FakeAirtable()
    for name in ("list_bases", "list_tables", "list_webhooks"):
        monkeypatch.setattr(
            f"mirage.core.airtable.watch.{name}", getattr(fake, name)
        )
    monkeypatch.setattr(
        "mirage.core.airtable.watch.webhook_payloads", fake.webhook_payloads
    )
    return fake


def _hook() -> AirtableDeltaHook:
    return AirtableDeltaHook(AirtableAccessor(AirtableConfig(token="t")))


def _pairs(delta) -> list[tuple[FileChangeKind, str]]:
    return [(c.kind, c.path.virtual) for c in delta.changes]


@pytest.mark.asyncio
async def test_a_baseline_starts_at_the_present_and_each_ping_reads_on(
    fake,
):
    fake.push(_records())
    hook = _hook()
    base = await hook.pull(_root(), None)
    assert base.changes == ()
    fake.push(_records())
    fake.push(_records())
    fake.push({"changedTablesById": {"tblF": {"changedViewsById": {"v": {}}}}})
    delta = await hook.pull(_root(), base.checkpoint)
    assert _pairs(delta) == [
        (U, f"{FEATURES}/records.jsonl"),
        (X, f"{FEATURES}/views"),
    ]
    again = await hook.pull(_root(), delta.checkpoint)
    assert again.changes == ()


@pytest.mark.asyncio
async def test_fields_and_tables_name_their_files(fake):
    hook = _hook()
    base = await hook.pull(_root(), None)
    fake.push(
        {
            "changedTablesById": {
                "tblF": {"changedFieldsById": {"fld1": {"current": {}}}}
            },
            "createdTablesById": {
                "tblN": {"metadata": {"name": "Notes"}, "fieldsById": {}}
            },
        }
    )
    delta = await hook.pull(_root(), base.checkpoint)
    assert _pairs(delta) == [
        (C, f"{BASE}/Notes__tblN/table.json"),
        (C, f"{BASE}/Notes__tblN/records.jsonl"),
        (X, f"{BASE}/Notes__tblN/views"),
        (U, f"{BASE}/base.json"),
        (U, f"{FEATURES}/table.json"),
        (U, f"{FEATURES}/records.jsonl"),
        (X, f"{FEATURES}/views"),
    ]
    fake.push(
        {
            "changedTablesById": {
                "tblN": {
                    "changedMetadata": {
                        "current": {"name": "Ideas"},
                        "previous": {"name": "Notes"},
                    }
                }
            }
        }
    )
    fake.push({"destroyedTableIds": ["tblF"]})
    fake.push(_records("tblN"))
    delta = await hook.pull(_root(), delta.checkpoint)
    assert _pairs(delta) == [
        (X, f"{BASE}/Notes__tblN"),
        (X, f"{BASE}/Ideas__tblN"),
        (U, f"{BASE}/base.json"),
        (D, FEATURES),
        (U, f"{BASE}/Ideas__tblN/records.jsonl"),
        (X, f"{BASE}/Ideas__tblN/views"),
    ]
    assert fake.calls.count("tables appA") == 1


@pytest.mark.asyncio
async def test_lost_payloads_are_unknown_on_the_watch_root(fake):
    hook = _hook()
    base = await hook.pull(_root(), None)
    fake.push(_records())
    fake.push(_records())
    fake.oldest = 2
    delta = await hook.pull(_root(), base.checkpoint)
    assert _pairs(delta)[0] == (X, "/at")
    fake.push({"error": True, "code": "INVALID_HOOK"})
    assert _pairs(await hook.pull(_root(), delta.checkpoint)) == [(X, "/at")]


@pytest.mark.asyncio
async def test_a_webhook_gone_is_lost_and_a_new_one_reads_from_its_start(
    fake,
):
    hook = _hook()
    base = await hook.pull(_root(), None)
    del fake.hooks["appA"]["achH"]
    fake.hooks["appA"]["achNew"] = []
    fake.push(_records(), hook_id="achNew")
    delta = await hook.pull(_root(), base.checkpoint)
    assert _pairs(delta) == [
        (X, "/at"),
        (U, f"{FEATURES}/records.jsonl"),
        (X, f"{FEATURES}/views"),
    ]


@pytest.mark.asyncio
async def test_a_new_webhook_whose_first_payloads_expired_is_lost(fake):
    fake.push(_records())
    fake.push(_records())
    hook = _hook()
    base = await hook.pull(_root(), None)
    fake.hooks["appA"]["achNew"] = []
    fake.push(_records(), hook_id="achNew")
    fake.push(_records(), hook_id="achNew")
    fake.oldest = 2
    delta = await hook.pull(_root(), base.checkpoint)
    assert _pairs(delta) == [
        (X, "/at"),
        (U, f"{FEATURES}/records.jsonl"),
        (X, f"{FEATURES}/views"),
    ]


@pytest.mark.asyncio
async def test_bases_come_and_go_and_a_base_root_lists_no_bases(fake):
    hook = _hook()
    base = await hook.pull(_root(), None)
    fake.bases = [
        {"id": "appB", "name": "Ops"},
    ]
    fake.tables["appB"] = []
    fake.hooks["appB"] = {}
    delta = await hook.pull(_root(), base.checkpoint)
    assert _pairs(delta) == [(X, "/at/bases/Ops__appB"), (D, BASE)]
    root = _root("bases/Roadmap__appA/Features__tblF")
    fake.calls.clear()
    base = await hook.pull(root, None)
    fake.push(_records())
    fake.push(_records("tblOther"))
    fake.tables["appA"].append({"id": "tblOther", "name": "Other"})
    delta = await hook.pull(root, base.checkpoint)
    assert _pairs(delta) == [
        (U, f"{FEATURES}/records.jsonl"),
        (X, f"{FEATURES}/views"),
    ]
    assert "bases" not in fake.calls


@pytest.mark.asyncio
async def test_a_base_the_mount_leaves_out_reads_nothing(fake):
    config = AirtableConfig(token="t", base_ids=["appB"])
    hook = AirtableDeltaHook(AirtableAccessor(config))
    root = _root("bases/Roadmap__appA")
    base = await hook.pull(root, None)
    fake.push(_records())
    assert (await hook.pull(root, base.checkpoint)).changes == ()
    assert fake.calls == []


@pytest.mark.asyncio
async def test_a_base_that_lost_payloads_names_its_tables_again(fake):
    hook = _hook()
    base = await hook.pull(_root(), None)
    fake.push(
        {
            "changedTablesById": {
                "tblF": {"changedMetadata": {"current": {"name": "Ideas"}}}
            }
        }
    )
    fake.oldest = 2
    fake.tables["appA"] = [{"id": "tblF", "name": "Ideas"}]
    delta = await hook.pull(_root(), base.checkpoint)
    assert _pairs(delta) == [(X, "/at")]
    fake.push(_records())
    assert _pairs(await hook.pull(_root(), delta.checkpoint)) == [
        (U, f"{BASE}/Ideas__tblF/records.jsonl"),
        (X, f"{BASE}/Ideas__tblF/views"),
    ]
