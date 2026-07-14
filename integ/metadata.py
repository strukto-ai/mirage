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
import logging
import os
import shutil
import sys
import tempfile
import uuid
from pathlib import Path

import boto3
from moto.server import ThreadedMotoServer

sys.path.insert(0, str(Path(__file__).parent))

from cases import meta_stat_line  # noqa: E402
from cases import run_meta_cases  # noqa: E402
from cases import run_meta_overlay_cases  # noqa: E402

from mirage import MountMode, Workspace  # noqa: E402
from mirage.resource.disk import DiskResource  # noqa: E402
from mirage.resource.ram import RAMResource  # noqa: E402
from mirage.resource.redis import RedisResource  # noqa: E402
from mirage.resource.s3 import S3Config, S3Resource  # noqa: E402
from mirage.types import PathSpec  # noqa: E402

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
BUCKET = "mirage-integ-meta"
CREDS = dict(aws_access_key_id="testing",
             aws_secret_access_key="testing",
             region_name="us-east-1")


async def run_overlay_snapshot_roundtrip(ws: Workspace, fresh) -> None:
    # Overlay attrs live in namespace NODES, so they must survive a
    # snapshot even though the s3 resource is rebuilt fresh at load
    # (s3 snapshots redact creds and require a resources= override).
    await ws.execute("echo alpha > /data/f.txt")
    await ws.execute("chmod 601 /data/f.txt && chown 500:dev /data/f.txt"
                     " && touch -t 202601021530 /data/f.txt")
    snap = Path(tempfile.mkdtemp(prefix="mirage-meta-osnap-")) / "ws.tar"
    await ws.snapshot(str(snap))
    restored = await Workspace.load(str(snap), resources={"/data": fresh})
    st, _ = await restored.dispatch("stat",
                                    PathSpec.from_str_path("/data/f.txt"))
    print("=== overlay_snapshot_roundtrip ===")
    print(meta_stat_line(st, ("mode", "uid", "gid", "mtime")))
    await restored.execute("rm /data/f.txt")
    shutil.rmtree(snap.parent)


async def run_snapshot_roundtrip() -> None:
    ws = Workspace({"/data": RAMResource()}, mode=MountMode.WRITE)
    await ws.execute("echo alpha > /data/f.txt")
    await ws.execute("chmod 601 /data/f.txt && chown 500:dev /data/f.txt"
                     " && touch -t 202601021530 /data/f.txt")
    snap = Path(tempfile.mkdtemp(prefix="mirage-meta-snap-")) / "ws.tar"
    await ws.snapshot(str(snap))
    restored = await Workspace.load(str(snap))
    result = await restored.execute("ls -l /data")
    print("=== snapshot_meta_roundtrip ===")
    print((await result.stdout_str()).rstrip())
    shutil.rmtree(snap.parent)


async def main() -> None:
    print("##### ram #####")
    await run_meta_cases(
        Workspace({"/data": RAMResource()}, mode=MountMode.WRITE))

    print("##### disk #####")
    root = tempfile.mkdtemp(prefix="mirage-integ-meta-disk-")
    try:
        await run_meta_cases(
            Workspace({"/data": DiskResource(root=root)},
                      mode=MountMode.WRITE))
    finally:
        shutil.rmtree(root)

    print("##### redis #####")
    prefix = f"mirage-integ-meta-{uuid.uuid4().hex[:8]}/"
    resource = RedisResource(url=REDIS_URL, key_prefix=prefix)
    ws = Workspace({"/data": resource}, mode=MountMode.WRITE)
    try:
        await run_meta_cases(ws)
    finally:
        await ws.execute("rm -rf /data/metad")

    print("##### s3 (overlay) #####")
    logging.getLogger("werkzeug").setLevel(logging.ERROR)
    server = ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
    server.start()
    host, port = server.get_host_and_port()
    endpoint = f"http://{host}:{port}"
    config = S3Config(bucket=BUCKET,
                      region="us-east-1",
                      endpoint_url=endpoint,
                      aws_access_key_id="testing",
                      aws_secret_access_key="testing",
                      path_style=True)
    try:
        boto3.client("s3", endpoint_url=endpoint,
                     **CREDS).create_bucket(Bucket=BUCKET)
        s3_ws = Workspace({"/data": S3Resource(config)}, mode=MountMode.WRITE)
        await run_meta_overlay_cases(s3_ws)
        await run_overlay_snapshot_roundtrip(s3_ws, S3Resource(config))
    finally:
        server.stop()

    await run_snapshot_roundtrip()


if __name__ == "__main__":
    asyncio.run(main())
