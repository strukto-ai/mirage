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

import sqlite3
import threading
from collections.abc import Sequence

from mirage.vfs.sql.types import SqlDialect, SqlRow, SqlStatement, SqlValue


class SqliteDriver:
    """A SQLite file opened with ``sqlite3``, as the sql mount's driver.

    The file opens on the first statement, so building a mount never
    touches the disk. ``:memory:`` holds the database in this process
    alone. One connection serves every caller, serialized by a lock,
    because a snapshot reads it from a worker thread while the loop may
    still write. Mirrors TypeScript's ``SqliteDriver``.
    """

    def __init__(self, path: str = ":memory:") -> None:
        """Args:
        path (str): the database file, or ``:memory:``.
        """
        self.path = path
        self._db: sqlite3.Connection | None = None
        self._lock = threading.Lock()

    @property
    def location(self) -> str:
        return self.path

    @property
    def dialect(self) -> SqlDialect:
        return SqlDialect.SQLITE

    def _open(self) -> sqlite3.Connection:
        if self._db is None:
            # Autocommit, so a lone statement lands at once and batch
            # holds its own BEGIN and COMMIT.
            self._db = sqlite3.connect(
                self.path, check_same_thread=False, isolation_level=None
            )
            self._db.row_factory = sqlite3.Row
        return self._db

    def query(self, sql: str, params: Sequence[SqlValue] = ()) -> list[SqlRow]:
        with self._lock:
            rows = self._open().execute(sql, tuple(params)).fetchall()
        return [dict(row) for row in rows]

    def batch(self, statements: Sequence[SqlStatement]) -> None:
        with self._lock:
            db = self._open()
            db.execute("BEGIN")
            try:
                for s in statements:
                    db.execute(s.sql, s.params)
            except BaseException:
                db.execute("ROLLBACK")
                raise
            db.execute("COMMIT")

    def close(self) -> None:
        with self._lock:
            if self._db is not None:
                self._db.close()
                self._db = None
