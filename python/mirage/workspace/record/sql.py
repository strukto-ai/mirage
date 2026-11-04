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
from collections.abc import Iterable, Sequence

from mirage.concurrency.limiter import run_blocking
from mirage.vfs.sql.types import SqlDriver, SqlRow, SqlStatement, SqlValue
from mirage.workspace.record.types import RecordFields, generation_of

_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS mirage_records ("
    " scope TEXT NOT NULL, name TEXT NOT NULL, fields TEXT NOT NULL,"
    " generation BIGINT NOT NULL, PRIMARY KEY (scope, name))"
)

# Every statement the sql record client runs, by name. Mirrors
# TypeScript's ``RECORD_SQL``.
RECORD_SQL: dict[str, str] = {
    "get": "SELECT fields, generation FROM mirage_records"
    " WHERE scope = ? AND name = ?",
    "put": "INSERT INTO mirage_records"
    " (scope, name, fields, generation) VALUES (?, ?, ?, ?)"
    " ON CONFLICT (scope, name) DO UPDATE SET fields = excluded.fields,"
    " generation = excluded.generation",
    "insert_new": "INSERT INTO mirage_records"
    " (scope, name, fields, generation) VALUES (?, ?, ?, ?)"
    " ON CONFLICT (scope, name) DO NOTHING RETURNING name",
    "update_at": "UPDATE mirage_records SET fields = ?, generation = ?"
    " WHERE scope = ? AND name = ? AND generation = ? RETURNING name",
    "list_names": "SELECT name FROM mirage_records WHERE scope = ?",
    "delete": "DELETE FROM mirage_records WHERE scope = ? AND name = ?",
    "clear": "DELETE FROM mirage_records WHERE scope = ?",
}


class SqlRecordClient:
    """A keyed-record client over any ``SqlDriver``'s database: one JSON
    record per name in ``mirage_records``, scoped so sessions, the node
    table and metadata share one table.

    The generation lives in its own column, so a CAS write is one
    conditional statement: it lands only when the stored generation
    still matches. Mirrors TypeScript's ``SqlRecordClient``.
    """

    def __init__(self, driver: SqlDriver, scope: str) -> None:
        """Args:
        driver (SqlDriver): the database the records live in.
        scope (str): the prefix that keeps this table's names apart.
        """
        self._driver = driver
        self.scope = scope
        self._ready = False

    # The driver blocks, so each statement runs off the loop, the table
    # made first.
    async def _query(
        self, sql: str, params: Sequence[SqlValue]
    ) -> list[SqlRow]:
        await self._schema()
        return await run_blocking(self._driver.query, sql, params)

    async def _batch(self, statements: Sequence[SqlStatement]) -> None:
        await self._schema()
        await run_blocking(self._driver.batch, statements)

    async def _schema(self) -> None:
        if not self._ready:
            await run_blocking(self._driver.batch, [SqlStatement(_SCHEMA)])
            self._ready = True

    async def get(self, name: str) -> tuple[RecordFields | None, str]:
        rows = await self._query(RECORD_SQL["get"], (self.scope, name))
        if not rows:
            return None, ""
        return json.loads(str(rows[0]["fields"])), str(rows[0]["generation"])

    async def put(self, name: str, fields: RecordFields) -> None:
        await self._batch(
            [
                SqlStatement(
                    RECORD_SQL["put"],
                    (
                        self.scope,
                        name,
                        json.dumps(fields),
                        generation_of(fields),
                    ),
                )
            ]
        )

    async def cas_put(
        self, name: str, fields: RecordFields, expected_generation: int
    ) -> bool:
        body = json.dumps(fields)
        generation = generation_of(fields)
        if expected_generation != 0:
            return bool(
                await self._query(
                    RECORD_SQL["update_at"],
                    (body, generation, self.scope, name, expected_generation),
                )
            )
        if await self._query(
            RECORD_SQL["insert_new"], (self.scope, name, body, generation)
        ):
            return True
        # A record written before generations has none stored, which
        # counts as 0, so it is taken over the same way a new one is.
        return bool(
            await self._query(
                RECORD_SQL["update_at"],
                (body, generation, self.scope, name, 0),
            )
        )

    async def list_names(self) -> list[str]:
        rows = await self._query(RECORD_SQL["list_names"], (self.scope,))
        return sorted(str(r["name"]) for r in rows)

    async def delete(self, names: Iterable[str]) -> None:
        statements = [
            SqlStatement(RECORD_SQL["delete"], (self.scope, name))
            for name in names
        ]
        if statements:
            await self._batch(statements)

    async def clear(self) -> None:
        await self._batch([SqlStatement(RECORD_SQL["clear"], (self.scope,))])

    async def close(self) -> None:
        pass
