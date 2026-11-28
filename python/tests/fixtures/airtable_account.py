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

import json
from collections.abc import AsyncIterator
from typing import Any
from urllib.parse import parse_qsl, quote, unquote

import pytest_asyncio

from mirage.accessor.airtable import AirtableAccessor
from mirage.core.airtable.config import AirtableConfig
from tests.fixtures.kit_fake import KitRun

TOKEN = "patTest0000000001.secret"
ROADMAP = "appRoadmapBase001"
OPS = "appOpsFinance0001"
FEATURES = "tblFeatures000001"
BUDGET = "tblBudget00000001"
GRID = "viwGrid0000000001"
DONE = "viwDone0000000001"
DONE_FORMULA = "{Status}='Done'"
# Airtable's answer for a base, table or record the token cannot reach.
MODEL_NOT_FOUND = (
    "Invalid permissions, or the requested model was not "
    "found. Check that both your user and your token have the "
    "required permissions, and that the model names and/or "
    "ids are correct."
)
RECORDS = "/v0/:base/:table"
RECORD = "/v0/:base/:table/:record"
COMMENTS = "/v0/:base/:table/:record/comments"
BASES = "/v0/meta/bases"
TABLES = "/v0/meta/bases/:base/tables"
# The world integ/fixtures/airtable/unit.json seeds: two bases, Features
# with seven records (the odd ones Done) and Q3 / Budget with one.
FIXTURE = "unit"
WRITES = {
    ("POST", RECORDS): "create",
    ("PATCH", RECORDS): "update",
    ("DELETE", RECORDS): "delete",
    ("POST", COMMENTS): "comment",
}


class AirtableAccount:
    """One Airtable account on the integ Airtable fake, in the world the
    unit fixture seeds, and the reads a test checks it by.

    Args:
        origin (str): the Airtable fake's origin.
    """

    def __init__(self, origin: str) -> None:
        self.run = KitRun(origin, {"Authorization": f"Bearer {TOKEN}"})
        # What was recorded before the run was last reloaded.
        self.earlier: list[dict[str, Any]] = []

    async def reset(
        self, page_cap: int | None = None, fixture: str = FIXTURE
    ) -> None:
        """Seed the run afresh with a fixture's world, the unit one unless
        named.

        Args:
            page_cap (int | None): the most records, comments or payloads
                a page holds, the fixture's own if None.
            fixture (str): the fixture under integ/fixtures/airtable/.
        """
        body: dict[str, Any] = {"fixture": fixture}
        if page_cap is not None:
            body["extras"] = {"pageCap": page_cap}
        await self.run.call("POST", "/reset", json=body)

    def fields(self, **overrides: Any) -> dict[str, Any]:
        """A mount config's fields on the account, pacing off so a test
        runs at speed.

        Args:
            **overrides (Any): config fields to set or replace.
        """
        return {
            "token": TOKEN,
            "base_url": f"{self.run.url}/v0",
            "requests_per_second": 10_000.0,
            **overrides,
        }

    def config(self, **overrides: Any) -> AirtableConfig:
        """A mount config on the account.

        Args:
            **overrides (Any): config fields to set or replace.
        """
        return AirtableConfig(**self.fields(**overrides))

    def accessor(self, **overrides: Any) -> AirtableAccessor:
        """A Mirage accessor on the account.

        Args:
            **overrides (Any): config fields to set or replace.
        """
        return AirtableAccessor(self.config(**overrides))

    async def records(self, base: str, table: str) -> list[dict[str, Any]]:
        """Every record of a table, as Airtable answers them.

        Args:
            base (str): the base's id.
            table (str): the table's id or name.
        """
        found: list[dict[str, Any]] = []
        params: dict[str, str] = {}
        while True:
            page = await self.run.call(
                "GET", f"/v0/{base}/{quote(table, safe='')}", params=params
            )
            found.extend(page["records"])
            if "offset" not in page:
                return found
            params = {"offset": page["offset"]}

    async def comments(
        self, base: str, table: str, record: str
    ) -> list[dict[str, Any]]:
        """Every comment on a record, newest first, as Airtable answers.

        Args:
            base (str): the base's id.
            table (str): the table's id.
            record (str): the record's id.
        """
        found: list[dict[str, Any]] = []
        params: dict[str, str] = {}
        while True:
            page = await self.run.call(
                "GET",
                f"/v0/{base}/{quote(table, safe='')}/{record}/comments",
                params=params,
            )
            found.extend(page["comments"])
            if page.get("offset") is None:
                return found
            params = {"offset": page["offset"]}

    async def create(
        self, base: str, table: str, *cells: dict[str, Any]
    ) -> list[str]:
        """Create records as another client would, and their ids.

        Args:
            base (str): the base's id.
            table (str): the table's id.
            *cells (dict[str, Any]): each record's fields.
        """
        made = await self.run.call(
            "POST",
            f"/v0/{base}/{quote(table, safe='')}",
            json={"records": [{"fields": c} for c in cells]},
        )
        return [r["id"] for r in made["records"]]

    async def update(
        self, base: str, table: str, record: str, **cells: Any
    ) -> None:
        """Change a record's cells as another client would.

        Args:
            base (str): the base's id.
            table (str): the table's id.
            record (str): the record's id.
            **cells (Any): the cells to set.
        """
        await self.run.call(
            "PATCH",
            f"/v0/{base}/{quote(table, safe='')}/{record}",
            json={"fields": cells},
        )

    async def delete(self, base: str, table: str, record: str) -> None:
        """Delete a record as another client would.

        Args:
            base (str): the base's id.
            table (str): the table's id.
            record (str): the record's id.
        """
        await self.run.call(
            "DELETE", f"/v0/{base}/{quote(table, safe='')}/{record}"
        )

    async def record_requests(self) -> None:
        """Start listing the account's requests afresh."""
        self.earlier = []
        await self.run.record_requests()

    async def store(self, sql: str, *params: Any) -> None:
        """Store a state no Airtable request makes, one SQL statement on
        the run. That reloads the run, which stops a recording, so the
        requests listed so far are kept and the recording starts again.

        Args:
            sql (str): the statement.
            *params (Any): its parameters.
        """
        self.earlier += await self._recorded()
        await self.run.execute(sql, *params)
        await self.run.record_requests()

    async def webhook(self, base: str) -> str:
        """Make a webhook on a base, as its owner would, and its id.

        Args:
            base (str): the base's id.
        """
        made = await self.run.call(
            "POST",
            f"/v0/bases/{base}/webhooks",
            json={
                "specification": {
                    "options": {"filters": {"dataTypes": ["tableData"]}}
                }
            },
        )
        return str(made["id"])

    async def drop_webhook(self, base: str, hook: str) -> None:
        """Delete a webhook, as its owner would.

        Args:
            base (str): the base's id.
            hook (str): the webhook's id.
        """
        await self.run.call("DELETE", f"/v0/bases/{base}/webhooks/{hook}")

    async def push(self, hook: str, payload: dict[str, Any]) -> None:
        """Add a payload to a webhook, numbered after its last. The fake
        writes payloads only for record writes, so one about a schema or
        an error is stored as Airtable would leave it.

        Args:
            hook (str): the webhook's id.
            payload (dict[str, Any]): the payload as Airtable sends it.
        """
        await self.store(
            "INSERT INTO AirtableWebhookPayload "
            '(tenant, webhookId, cursor, "transaction", body) '
            "SELECT tenant, id, lastCursor + 1, "
            '(SELECT COALESCE(MAX("transaction"), 0) + 1 '
            "FROM AirtableWebhookPayload WHERE tenant = 'default'), ? "
            "FROM AirtableWebhook WHERE tenant = 'default' AND id = ?",
            json.dumps(payload),
            hook,
        )
        await self.store(
            "UPDATE AirtableWebhook SET lastCursor = lastCursor + 1 "
            "WHERE tenant = 'default' AND id = ?",
            hook,
        )

    async def expire(self, hook: str, oldest: int) -> None:
        """Let a webhook's payloads before ``oldest`` expire, as Airtable
        lets them after seven days.

        Args:
            hook (str): the webhook's id.
            oldest (int): the first payload kept.
        """
        await self.store(
            "DELETE FROM AirtableWebhookPayload WHERE tenant = 'default' "
            "AND webhookId = ? AND cursor < ?",
            hook,
            oldest,
        )

    async def _recorded(self) -> list[dict[str, Any]]:
        listed = await self.run.call("GET", "/_kit/requests")
        requests: list[dict[str, Any]] = listed["requests"]
        return requests

    async def _listed(self) -> list[dict[str, Any]]:
        return self.earlier + await self._recorded()

    async def record_queries(self) -> list[dict[str, str]]:
        """The query of each records listing since recording started, with
        the table it names, in order."""
        return [
            {
                **dict(parse_qsl(r["query"], keep_blank_values=True)),
                "table": unquote(r["path"].split("/")[3]),
            }
            for r in await self._listed()
            if r["method"] == "GET" and r["route"] == RECORDS
        ]

    async def writes(self) -> list[tuple[str, Any]]:
        """Each write since recording started, in order: ``create``,
        ``update`` and ``comment`` with the JSON they carried, ``delete``
        with the record ids it named."""
        out: list[tuple[str, Any]] = []
        for r in await self._listed():
            kind = WRITES.get((r["method"], r["route"]))
            if kind is None:
                continue
            if kind == "delete":
                ids = [
                    v
                    for k, v in parse_qsl(r["query"])
                    if k in ("records[]", "records")
                ]
                out.append((kind, ids))
            else:
                out.append((kind, r["body"]))
        return out

    async def asked(self) -> list[str]:
        """Each request since recording started, as ``METHOD route``."""
        return [f"{r['method']} {r['route']}" for r in await self._listed()]


@pytest_asyncio.fixture
async def airtable_account(
    airtable_origin: str,
) -> AsyncIterator[AirtableAccount]:
    """An account of its own on the Airtable fake, in the unit world, its
    requests recorded from here.

    Args:
        airtable_origin (str): the fake's origin.
    """
    made = AirtableAccount(airtable_origin)
    await made.reset()
    await made.run.record_requests()
    yield made
    await made.run.close()
