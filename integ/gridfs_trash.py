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
import json
import os
import shutil
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Any

_INTEG_DIR = str(Path(__file__).resolve().parent)
_INTEG_ALIASES = {_INTEG_DIR, str(Path(__file__).parent), ""}
_ON_PATH = any(p in _INTEG_ALIASES for p in sys.path)
sys.path[:] = [p for p in sys.path if p not in _INTEG_ALIASES]

from pydantic import SecretStr  # noqa: E402
from pymongo import AsyncMongoClient  # noqa: E402

from mirage import MountMode, Workspace  # noqa: E402
from mirage.vfs.gridfs import GridFSConfig, GridFSVFS  # noqa: E402

if _ON_PATH:
    sys.path.insert(0, _INTEG_DIR)

URI = os.environ.get("MONGODB_URI", "mongodb://localhost:27017")


async def shell(ws: Workspace, line: str) -> dict[str, str | int]:
    result = await ws.shell(line)
    return {
        "exit": result.exit_code,
        "stdout": await result.stdout_str(),
        "stderr": await result.stderr_str(),
    }


async def restored_reads(
    snap: Path, config: GridFSConfig
) -> dict[str, str | int | bool]:
    """What a workspace restored from ``snap`` reads at ``/data/f.txt``,
    past the restored cache, so the pinned stat and read reach the trashed
    revision itself.

    Args:
        snap (Path): the snapshot tar.
        config (GridFSConfig): the mount the snapshot was taken on.
    """
    # A load leaves the override to its caller, open MongoDB client and all.
    fresh = GridFSVFS(config)
    restored = await Workspace.load(str(snap), mounts={"/data": fresh})
    try:
        await restored.cache.remove("/data/f.txt")
        return {
            "pinned": "/data/f.txt" in restored.revisions,
            "size": (await shell(restored, "stat -c %s /data/f.txt"))[
                "stdout"
            ],
            "cat": (await shell(restored, "cat /data/f.txt"))["stdout"],
        }
    finally:
        await restored.close()
        await fresh.close()


async def probe(config: GridFSConfig) -> dict[str, str | int | bool]:
    """Snapshot a read, rm the file, and restore: once while the file is
    still deleted, once after a rewrite. The battery cannot snapshot a
    workspace or reload it onto a fresh VFS, so this runs here, against the
    MongoDB the shared battery jobs already start.

    Args:
        config (GridFSConfig): a mount on a database of its own.
    """
    # Written by one workspace and read by another, so the read reaches
    # the backend and records the revision the snapshot pins; a read
    # served from the writer's cache records nothing.
    writer = Workspace({"/data": GridFSVFS(config)}, mode=MountMode.WRITE)
    try:
        await shell(writer, "printf v1 > /data/f.txt")
    finally:
        await writer.close()
    ws = Workspace({"/data": GridFSVFS(config)}, mode=MountMode.WRITE)
    snap = Path(tempfile.mkdtemp(prefix="mirage-gridfs-trash-")) / "ws.tar"
    out: dict[str, str | int | bool] = {}
    try:
        out["before_snapshot"] = (await shell(ws, "cat /data/f.txt"))["stdout"]
        await ws.snapshot(str(snap))
        await shell(ws, "printf v2 > /data/f.txt")
        await shell(ws, "rm /data/f.txt")
        gone = await shell(ws, "cat /data/f.txt")
        out["after_rm_exit"] = gone["exit"]
        out["after_rm_stderr"] = gone["stderr"]
        out["after_rm_ls"] = (await shell(ws, "ls /data"))["stdout"]
        deleted = await restored_reads(snap, config)
        out["restored_pinned"] = deleted["pinned"]
        out["restored_deleted_size"] = deleted["size"]
        out["restored_deleted"] = deleted["cat"]
        await shell(ws, "printf v3 > /data/f.txt")
        out["after_rewrite"] = (await shell(ws, "cat /data/f.txt"))["stdout"]
        out["restored"] = (await restored_reads(snap, config))["cat"]
    finally:
        await ws.close()
        shutil.rmtree(snap.parent)
    return out


async def main() -> None:
    database = f"mirage_integ_trash_{uuid.uuid4().hex[:8]}"
    config = GridFSConfig(uri=SecretStr(URI), database=database, bucket="data")
    try:
        result = await probe(config)
    finally:
        client: AsyncMongoClient[dict[str, Any]] = AsyncMongoClient(URI)
        try:
            await client.drop_database(database)
        finally:
            await client.close()
    print(json.dumps(result))


if __name__ == "__main__":
    asyncio.run(main())
