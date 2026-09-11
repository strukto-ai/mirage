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

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.resource.s3 import S3Config, S3Resource

load_dotenv(".env.development")

config = S3Config(
    bucket=os.environ["AWS_S3_BUCKET"],
    region=os.environ.get("AWS_DEFAULT_REGION", "us-east-1"),
    aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
    aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
)

deep_config = S3Config(
    bucket=os.environ["AWS_S3_BUCKET"],
    region=os.environ.get("AWS_DEFAULT_REGION", "us-east-1"),
    aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
    aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
    key_prefix="subdata/subsubdata/",
)

resource = S3Resource(config)
deep_resource = S3Resource(deep_config)


async def main():
    with Workspace(
        {
            "/s3/": resource,
            "/deep/": deep_resource
        },
            mode=MountMode.READ,
    ) as ws:
        print("=== VFS MODE: open() reads from S3 transparently ===\n")

        print("--- os.listdir() root ---")
        root = os.listdir("/s3")
        for e in root:
            print(f"  {e}")

        print("\n--- os.path.isdir() on prefix ---")
        print(f"  /s3/data: {os.path.isdir('/s3/data')}")

        print("\n--- open() + read ---")
        with open("/s3/data/example.jsonl") as f:
            for i, line in enumerate(f):
                if i >= 3:
                    break
                rec = json.loads(line)
                print(f"  [{i}] {json.dumps(rec)[:100]}...")

        print("\n--- os.listdir() ---")
        entries = os.listdir("/s3/data")
        for e in entries:
            print(f"  {e}")

        print("\n--- os.path.exists() ---")
        print(f"  example.jsonl: {os.path.exists('/s3/data/example.jsonl')}")
        print(f"  nonexistent: {os.path.exists('/s3/data/nope.txt')}")

        print("\n--- VFS commands ---")
        result = await ws.execute("grep -c mirage /s3/data/example.jsonl")
        print(f"  grep matches: {(await result.stdout_str()).strip()}")

        print("\n=== KEY_PREFIX MOUNT (/deep → subdata/subsubdata/) ===\n")
        print(f"  key_prefix = {deep_config.key_prefix!r}\n")

        print("--- os.listdir('/deep') ---")
        for e in os.listdir("/deep"):
            print(f"  {e}")

        print("\n--- os.path.exists / isdir / getsize ---")
        print(f"  /deep/example.jsonl  exists: "
              f"{os.path.exists('/deep/example.jsonl')}")
        print(f"  /deep/example.json   isdir : "
              f"{os.path.isdir('/deep/example.json')}")
        print(f"  /deep/example.json   size  : "
              f"{os.path.getsize('/deep/example.json')} bytes")

        print("\n--- open() + read first 3 records ---")
        with open("/deep/example.jsonl") as f:
            for i, line in enumerate(f):
                if i >= 3:
                    break
                rec = json.loads(line)
                print(f"  [{i}] {json.dumps(rec)[:90]}...")

        print("\n--- VFS commands against /deep ---")
        r = await ws.execute("grep -c mirage /deep/example.jsonl")
        print(f"  grep -c mirage     : {(await r.stdout_str()).strip()}")
        r = await ws.execute("rg -l mirage /deep")
        print(f"  rg -l mirage       : {(await r.stdout_str()).strip()}")
        r = await ws.execute("jq .metadata.version /deep/example.json")
        print(f"  jq .metadata.version: {(await r.stdout_str()).strip()}")

        print("\n--- bash history ---")
        with open("/.bash_history") as f:
            for i, line in enumerate(f):
                if i >= 6:
                    break
                print(f"  {line.rstrip()[:120]}")

        records = ws.fs.records
        total = sum(r.bytes for r in records)
        print(f"\nStats: {len(records)} ops, {total} bytes transferred")


asyncio.run(main())
