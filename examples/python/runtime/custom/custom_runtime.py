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

import asyncio
import os
import sqlite3
import tempfile
from pathlib import Path

from mirage import Workspace
from mirage.config import load_config

# workspace.yaml loads SqliteRuntime from sqlite_runtime.py beside it. The
# agent only ever types sqlite3; the yaml decides where that runs. Needs the
# sqlite3 command-line tool on PATH.

HERE = Path(__file__).resolve().parent

LINES = [
    ("sqlite3 /data/shop.db 'select count(*) from orders'", "a query"),
    (
        "sqlite3 -json /data/shop.db 'select * from orders' | jq -r '.[].item'",
        "its output pipes into workspace commands",
    ),
    (
        "echo 'select sum(total) from orders;' | sqlite3 /data/shop.db",
        "SQL on stdin",
    ),
    (
        "cd /data && sqlite3 shop.db \"insert into orders values (4, 'lamp', 30)\"",
        "a write, relative to the cwd, lands back in the mount",
    ),
    ("sqlite3 /data/shop.db 'select count(*) from orders'", "and stays"),
    (
        "sqlite3 /archive/2025.db \"insert into orders values (9, 'x', 1)\"",
        "a read-only mount refuses the write-back",
    ),
    ("sqlite3 /archive/2025.db 'select count(*) from orders'", "unchanged"),
]


def database() -> bytes:
    """A small orders database, as bytes to seed the mounts with."""
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "shop.db"
        db = sqlite3.connect(path)
        db.execute("create table orders (id int, item text, total int)")
        db.executemany(
            "insert into orders values (?, ?, ?)",
            [(1, "desk", 120), (2, "chair", 80), (3, "shelf", 45)],
        )
        db.commit()
        db.close()
        return path.read_bytes()


async def main() -> None:
    with tempfile.TemporaryDirectory() as archive:
        (Path(archive) / "2025.db").write_bytes(database())
        os.environ["ARCHIVE_DIR"] = archive
        config = load_config(HERE / "workspace.yaml")
        ws = Workspace(**config.to_workspace_kwargs())
        try:
            await ws.vfs.write("/data/shop.db", database())
            for line, note in LINES:
                res = await ws.shell(line)
                print(f"$ {line}    # {note}")
                print((res.stdout or b"").decode(), end="")
                print((res.stderr or b"").decode(), end="")
                print(f"[exit {res.exit_code}]\n")
        finally:
            await ws.close()


if __name__ == "__main__":
    asyncio.run(main())
