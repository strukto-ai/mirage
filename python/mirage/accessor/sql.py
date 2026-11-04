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

from collections.abc import Sequence

from mirage.accessor.base import Accessor
from mirage.core.sql.constants import DEFAULT_CHUNK_SIZE, SCHEMA, SQL
from mirage.utils.clock import system_date
from mirage.vfs.sql.types import SqlDriver, SqlRow, SqlStatement, SqlValue


class SqlAccessor(Accessor):
    """A sql mount's database: its driver, and the tables the ops read,
    made on the first statement. Mirrors TypeScript's ``SqlAccessor``.
    """

    def __init__(self, driver: SqlDriver) -> None:
        """Args:
        driver (SqlDriver): the database the mount lives in.
        """
        self.driver = driver
        self._chunk_size: int | None = None

    def chunk_size(self) -> int:
        """The bytes one row of a file holds, as the database records
        it; the tables and the root are made first when the database has
        none."""
        if self._chunk_size is None:
            now = int(system_date().timestamp())
            self.driver.batch(
                [
                    *(
                        SqlStatement(sql)
                        for sql in SCHEMA[self.driver.dialect]
                    ),
                    SqlStatement(SQL["seed_root"], (now, now, now)),
                ]
            )
            rows = self.driver.query(SQL["chunk_size"])
            value = rows[0]["value"] if rows else None
            self._chunk_size = int(value or 0) or DEFAULT_CHUNK_SIZE
        return self._chunk_size

    def query(self, sql: str, params: Sequence[SqlValue] = ()) -> list[SqlRow]:
        """The rows one statement answers, once the tables are there."""
        self.chunk_size()
        return self.driver.query(sql, params)

    def batch(self, statements: Sequence[SqlStatement]) -> None:
        """Run ``statements`` in one transaction, once the tables are
        there."""
        if not statements:
            return
        self.chunk_size()
        self.driver.batch(statements)
