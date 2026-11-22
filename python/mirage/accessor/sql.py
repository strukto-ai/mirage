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

import logging
import re
import weakref
from collections.abc import Sequence

from mirage.accessor.base import Accessor
from mirage.concurrency.limiter import run_blocking
from mirage.core.sql.constants import (
    DEFAULT_CHUNK_SIZE,
    DIR,
    LAST_INO,
    ROOT_INO,
    SCHEMA,
    SQL,
)
from mirage.errors.fs import enoent, enotdir
from mirage.types import PathSpec
from mirage.utils.clock import system_date
from mirage.utils.path import norm
from mirage.vfs.sql.types import SqlDriver, SqlRow, SqlStatement, SqlValue

logger = logging.getLogger(__name__)

# How many times each driver's tree lost or moved an entry, through any
# mount on it.
STRUCTURE: "weakref.WeakKeyDictionary[SqlDriver, int]" = (
    weakref.WeakKeyDictionary()
)
# A statement that removes or moves an entry or an inode.
RESHAPES = re.compile(r"DELETE FROM fs_(?:inode|dentry)|UPDATE fs_dentry")


class SqlAccessor(Accessor):
    """A sql mount's database: its driver, the folder of it the mount
    serves, and the tables the ops read, made on the first statement with
    the folder. The driver blocks, so every live call runs off the loop;
    the snapshot, already on a worker thread, calls it directly. Mirrors
    TypeScript's ``SqlAccessor``.
    """

    def __init__(self, driver: SqlDriver, root: str = "/") -> None:
        """Args:
        driver (SqlDriver): the database the mount lives in.
        root (str): the folder of the database the mount serves, ``/``
            for all of it.
        """
        self.driver = driver
        self.root = norm(root)
        bare = self.root.strip("/")
        # The names the ops walk from the database's root to ``root``.
        self.root_names: tuple[str, ...] = (
            tuple(bare.split("/")) if bare else ()
        )
        self._chunk_size: int | None = None

    def ready(self) -> int:
        """The bytes one row of a file holds, as the database records
        it; the tables, the root and the mount's folder are made first
        when the database has none. Blocks: for a caller off the loop."""
        if self._chunk_size is None:
            now = int(system_date().timestamp())
            self.driver.batch(
                [
                    *(
                        SqlStatement(sql)
                        for sql in SCHEMA[self.driver.dialect]
                    ),
                    SqlStatement(SQL["seed_root"], (now,)),
                ]
            )
            rows = self.driver.query(SQL["chunk_size"])
            value = rows[0]["value"] if rows else None
            self._folder()
            self._chunk_size = int(value or 0) or DEFAULT_CHUNK_SIZE
        return self._chunk_size

    def root_ino(self) -> int:
        """The inode of the mount's folder, made again with its parents
        when gone, so a snapshot of the whole database taken first
        restores beside it in either order. A file standing at it is
        ENOTDIR. Blocks: for a caller off the loop."""
        self.ready()
        return self._folder()

    def _folder(self) -> int:
        # Each name of the folder in turn, made where the database has
        # none, as the root is: a directory inode and the entry naming it,
        # its parent named through its inode. A writer that makes one
        # first holds its entry, so this one's insert fails and it reads
        # the entry instead.
        ino = ROOT_INO
        for name in self.root_names:
            rows = self.driver.query(SQL["entry"], (ino, name))
            if not rows:
                now = int(system_date().timestamp())
                try:
                    self.driver.batch(
                        [
                            SqlStatement(SQL["new_inode"], (DIR, 0, now, 0)),
                            SqlStatement(
                                "INSERT INTO fs_dentry (name, parent_ino, ino)"
                                " VALUES (?, (SELECT ino FROM fs_inode"
                                " WHERE ino = ?),"
                                f" {LAST_INO[self.driver.dialect]})",
                                (name, ino),
                            ),
                        ]
                    )
                except Exception as exc:
                    if not self.driver.query(SQL["entry"], (ino, name)):
                        raise
                    logger.debug(
                        "sql: %s was made by another writer first: %s",
                        self.root,
                        exc,
                    )
                rows = self.driver.query(SQL["entry"], (ino, name))
            if not rows:
                raise enoent(PathSpec.from_str_path(self.root))
            if int(rows[0]["mode"] or 0) != DIR:
                raise enotdir(PathSpec.from_str_path(self.root))
            ino = int(rows[0]["ino"] or 0)
        return ino

    async def chunk_size(self) -> int:
        """``ready``, off the loop the first time."""
        if self._chunk_size is not None:
            return self._chunk_size
        return await run_blocking(self.ready)

    async def query(
        self, sql: str, params: Sequence[SqlValue] = ()
    ) -> list[SqlRow]:
        """The rows one statement answers, once the tables are there."""
        await self.chunk_size()
        return await run_blocking(self.driver.query, sql, params)

    async def batch(self, statements: Sequence[SqlStatement]) -> None:
        """Run ``statements`` in one transaction, once the tables are
        there. One that removes or moves an entry moves ``structure`` on,
        before it runs and once it has, so nothing read while it ran is
        kept."""
        if not statements:
            return
        await self.chunk_size()
        if not any(RESHAPES.search(s.sql) for s in statements):
            await run_blocking(self.driver.batch, statements)
            return
        self.reshaped()
        try:
            await run_blocking(self.driver.batch, statements)
        finally:
            self.reshaped()

    def structure(self) -> int:
        """A count that moves whenever the driver's tree loses or moves an
        entry: what a path resolved to is as it was only while this reads
        the same."""
        return STRUCTURE.get(self.driver, 0)

    def reshaped(self) -> None:
        """Mark the tree as having lost or moved an entry."""
        STRUCTURE[self.driver] = self.structure() + 1
