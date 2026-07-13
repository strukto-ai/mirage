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

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.resource.ram import RAMResource
from mirage.resource.s3 import S3Config, S3Resource

load_dotenv(".env.development")

config = S3Config(
    bucket=os.environ["AWS_S3_BUCKET"],
    region=os.environ.get("AWS_DEFAULT_REGION", "us-east-1"),
    aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
    aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
)

s3 = S3Resource(config)
mem = RAMResource()
ws = Workspace(
    {
        "/s3/": s3,
        "/work/": (mem, MountMode.WRITE)
    },
    mode=MountMode.EXEC,
)

# Monty file handles are not iterable; readlines() works.
SCRIPT = r"""
import json

with open("/s3/data/example.jsonl") as f:
    lines = f.readlines()
for i, line in enumerate(lines[:5]):
    rec = json.loads(line)
    print(f"[{i}] {json.dumps(rec)[:120]}...")
"""


async def main():
    print("=== Python exec: read first 5 lines of JSONL from S3 ===\n")

    await ws.execute("mkdir /work/scripts")
    await ws.execute(f"echo '{SCRIPT}' > /work/scripts/read_jsonl.py")

    print("--- python3 /work/scripts/read_jsonl.py ---")
    result = await ws.execute("python3 /work/scripts/read_jsonl.py")
    print(await result.stdout_str())
    if result.stderr:
        print("STDERR:", await result.stderr_str())
    print(f"Exit code: {result.exit_code}")
    records = ws.ops.records
    total = sum(r.bytes for r in records)
    print(f"Stats: {len(records)} ops, {total} bytes transferred")

    print("\n--- shell equivalent: head -n 5 ---")
    result = await ws.execute("head -n 5 /s3/data/example.jsonl")
    print(await result.stdout_str())


asyncio.run(main())
