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

# Runs inside a Daytona sandbox (uploaded by ../daytona_vfs.py).

import asyncio
import os

from mirage import MountMode, Workspace
from mirage.resource.s3 import S3Config, S3Resource


async def run():
    cfg = S3Config(
        bucket=os.environ["AWS_S3_BUCKET"],
        region=os.environ.get("AWS_DEFAULT_REGION", "us-east-1"),
        aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
    )
    with Workspace({"/s3/": S3Resource(cfg)}, mode=MountMode.READ) as ws:
        r = await ws.execute("ls /s3/")
        print("--- ls /s3/ ---")
        print((await r.stdout_str()).rstrip())

        r = await ws.execute("grep -c mirage /s3/data/example.jsonl")
        print("\n--- grep -c mirage /s3/data/example.jsonl ---")
        print((await r.stdout_str()).rstrip())

        records = ws.ops.records
        total = sum(rec.bytes for rec in records)
        print(f"\nremote stats: {len(records)} ops, {total} bytes")


asyncio.run(run())
