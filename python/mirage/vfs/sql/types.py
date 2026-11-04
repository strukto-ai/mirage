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
from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol, TypeAlias

# A value one SQL parameter or column carries.
SqlValue: TypeAlias = str | int | float | bytes | None

# One row a query answers, by column name.
SqlRow: TypeAlias = dict[str, SqlValue]


@dataclass(frozen=True)
class SqlStatement:
    """One statement and its positional ``?`` parameters."""

    sql: str
    params: tuple[SqlValue, ...] = ()


class SqlDialect(StrEnum):
    """The SQL a database speaks where databases part: the column types
    its tables are made with, and how a statement names the inode the
    one before it made. Every other statement the sql ops run is plain
    SQL every dialect reads. Mirrors TypeScript's ``SqlDialect``.
    """

    SQLITE = "sqlite"
    POSTGRES = "postgres"


class SqlDriver(Protocol):
    """A database as the sql ops reach it.

    Every op reaches its database through this surface and nothing else,
    so the host is the driver's business. Statements number their
    parameters ``?``; a driver whose database numbers them otherwise
    renumbers them. A BLOB column comes back as ``bytes``. Synchronous,
    as ``sqlite3`` is: the ops call it from their async functions and
    the snapshot from its worker thread. Mirrors TypeScript's
    ``SqlDriver``.
    """

    @property
    def location(self) -> str:
        """Where the database lives, for ``storage_location`` and ``df``."""
        ...

    @property
    def dialect(self) -> SqlDialect: ...

    def query(self, sql: str, params: Sequence[SqlValue] = ()) -> list[SqlRow]:
        """The rows one statement answers."""
        ...

    def batch(self, statements: Sequence[SqlStatement]) -> None:
        """Run every statement in one transaction: all land or none."""
        ...

    def close(self) -> None: ...
