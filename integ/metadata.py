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

# The per-command metadata cases this file used to run now live in
# integ/unix/meta and integ/unix/meta_overlay, where the JSON battery runs
# them on 22 backends instead of the four here. What is left are the three
# scenarios the declarative harness cannot express: it can run commands and
# stat paths, but it cannot snapshot a workspace, reload it onto a fresh
# VFS, or mutate a backend out of band. Retiring these needs snapshot
# and namespace support in the harness, not another case file.
#
# Emits its result as one JSON line for integ/check_json.py, so the moto
# server's own chatter cannot break the check and the TypeScript twin
# reports `before`/`after` as real booleans rather than Python spellings.

import asyncio
import json
import logging
import os
import shutil
import sys
import tempfile
import uuid
from pathlib import Path

import boto3
from moto.server import ThreadedMotoServer

# Importing mirage while this directory is on sys.path resolves the
# `redis` package to integ/redis.py (mirage swallows the resulting
# ImportError as "redis extra not installed", and the half-executed
# shadow module strips this directory from sys.path, breaking the
# caller's next sibling import). Import mirage with the directory off
# the path, mirroring integ/redis.py's own guard.
_INTEG_DIR = str(Path(__file__).resolve().parent)
_INTEG_ALIASES = {_INTEG_DIR, str(Path(__file__).parent), ""}
_ON_PATH = any(p in _INTEG_ALIASES for p in sys.path)
sys.path[:] = [p for p in sys.path if p not in _INTEG_ALIASES]

from mirage import MountMode, ReadPolicy, ReadSpec, Workspace  # noqa: E402
from mirage.types import FileStat, PathSpec  # noqa: E402
from mirage.vfs.ram import RAMVFS  # noqa: E402
from mirage.vfs.s3 import S3VFS, S3Config  # noqa: E402

if _ON_PATH:
    sys.path.insert(0, _INTEG_DIR)

# Every value the truth file asserts: text for the overlay attributes and the
# ls row, a real boolean for the GC pair. Mirrors the TypeScript twin's
# Record<string, string | boolean | null>.
MetaValue = str | bool | None

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
BUCKET = "mirage-integ-meta"
CREDS = dict(aws_access_key_id="testing",
             aws_secret_access_key="testing",
             region_name="us-east-1")


def overlay_stat_fields(st: FileStat) -> dict[str, MetaValue]:
    """Render the four overlay attributes as truth-file values.

    `uid` and `gid` are `int | str | None` in both languages, so they are
    normalized to text rather than left to serialize as whichever the
    backend happened to store.

    Args:
        st (FileStat): the stat of the restored file.

    Returns:
        dict[str, MetaValue]: the asserted keys for this scenario.
    """
    return {
        "overlay_snapshot_mode":
        oct(st.mode)[2:] if st.mode is not None else None,
        "overlay_snapshot_uid": str(st.uid) if st.uid is not None else None,
        "overlay_snapshot_gid": str(st.gid) if st.gid is not None else None,
        # First 19 chars ("2026-01-02T15:30:00") so the Z vs +00:00 suffix
        # never reaches the truth file.
        "overlay_snapshot_mtime": st.modified[:19] if st.modified else None,
    }


async def run_overlay_snapshot_roundtrip(ws: Workspace,
                                         fresh: S3VFS) -> dict[str, MetaValue]:
    # Overlay attrs live in namespace NODES, so they must survive a
    # snapshot even though the s3 VFS is rebuilt fresh at load
    # (s3 snapshots redact creds and require a mounts= override).
    await ws.shell("echo alpha > /data/f.txt")
    await ws.shell("chmod 601 /data/f.txt && chown 500:dev /data/f.txt"
                   " && touch -t 202601021530 /data/f.txt")
    snap = Path(tempfile.mkdtemp(prefix="mirage-meta-osnap-")) / "ws.tar"
    await ws.snapshot(str(snap))
    restored = await Workspace.load(str(snap), mounts={"/data": fresh})
    st, _ = await restored.dispatch("stat",
                                    PathSpec.from_str_path("/data/f.txt"))
    await restored.shell("rm /data/f.txt")
    shutil.rmtree(snap.parent)
    return overlay_stat_fields(st)


async def run_overlay_orphan_gc(config: S3Config) -> dict[str, MetaValue]:
    # A chmod on a slot-less backend (s3) creates an attribute overlay in
    # the namespace. When the object is deleted out-of-band (another agent,
    # the raw API), the overlay is orphaned. Under `read: fresh`, a stat
    # the backend reports gone must GC that orphaned node.
    ws = Workspace({"/data": S3VFS(config)},
                   mode=MountMode.WRITE,
                   read=ReadSpec(policy=ReadPolicy.FRESH))
    await ws.shell("echo alpha > /data/g.txt && chmod 601 /data/g.txt")
    before = ws.namespace.meta_for("/data/g.txt") is not None
    mount = ws.namespace.mount_for("/data/g.txt")
    await mount.execute_op("unlink", "/data/g.txt")
    await ws.shell("stat /data/g.txt")
    after = ws.namespace.meta_for("/data/g.txt") is not None
    return {"overlay_orphan_before": before, "overlay_orphan_after": after}


async def run_snapshot_roundtrip() -> dict[str, MetaValue]:
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("echo alpha > /data/f.txt")
    await ws.shell("chmod 601 /data/f.txt && chown 500:dev /data/f.txt"
                   " && touch -t 202601021530 /data/f.txt")
    snap = Path(tempfile.mkdtemp(prefix="mirage-meta-snap-")) / "ws.tar"
    await ws.snapshot(str(snap))
    restored = await Workspace.load(str(snap))
    result = await restored.shell("ls -l /data")
    line = (await result.stdout_str()).rstrip()
    shutil.rmtree(snap.parent)
    return {"snapshot_ls_line": line}


async def main() -> None:
    logging.getLogger("werkzeug").setLevel(logging.ERROR)
    server = ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
    server.start()
    host, port = server.get_host_and_port()
    endpoint = f"http://{host}:{port}"
    bucket = f"{BUCKET}-{uuid.uuid4().hex[:8]}"
    config = S3Config(bucket=bucket,
                      region="us-east-1",
                      endpoint_url=endpoint,
                      aws_access_key_id="testing",
                      aws_secret_access_key="testing",
                      path_style=True)
    result: dict[str, MetaValue] = {}
    try:
        boto3.client("s3", endpoint_url=endpoint,
                     **CREDS).create_bucket(Bucket=bucket)
        s3_ws = Workspace({"/data": S3VFS(config)}, mode=MountMode.WRITE)
        overlay = await run_overlay_snapshot_roundtrip(s3_ws, S3VFS(config))
        result.update(overlay)
        result.update(await run_overlay_orphan_gc(config))
    finally:
        server.stop()

    result.update(await run_snapshot_roundtrip())
    print(json.dumps(result))


if __name__ == "__main__":
    asyncio.run(main())
