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

import os

from dotenv import load_dotenv

from mirage import Mount, MountMode, Workspace
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

with Workspace({
        "/s3/": Mount(resource, mode=MountMode.READ, fuse=True),
        "/deep/": deep_resource
}) as ws:
    mp = ws.fuse_mountpoint

    print(f"=== FUSE MODE: mounted at {mp} ===\n")

    print("--- os.listdir() ---")
    entries = os.listdir(f"{mp}/data")
    for e in entries:
        print(f"  {e}")

    print("\n--- open() + read ---")
    with open(f"{mp}/data/example.jsonl") as f:
        for i, line in enumerate(f):
            if i >= 3:
                break
            print(f"  [{i}] {line.strip()[:100]}...")

    print("\n--- os.path.getsize() ---")
    size = os.path.getsize(f"{mp}/data/example.jsonl")
    print(f"  size: {size} bytes")

    print("\n=== KEY_PREFIX MOUNT (/deep → subdata/subsubdata/) ===")
    print(f"  key_prefix = {deep_config.key_prefix!r}\n")

    print(f"--- os.listdir({mp}/deep) ---")
    for e in os.listdir(f"{mp}/deep"):
        print(f"  {e}")

    print(f"\n--- open({mp}/deep/example.jsonl) + read 3 lines ---")
    with open(f"{mp}/deep/example.jsonl") as f:
        for i, line in enumerate(f):
            if i >= 3:
                break
            print(f"  [{i}] {line.strip()[:100]}...")

    print(f"\n--- os.path.getsize({mp}/deep/example.jsonl) ---")
    deep_size = os.path.getsize(f"{mp}/deep/example.jsonl")
    print(f"  size: {deep_size} bytes")
    print("  (resolves to s3://bucket/subdata/subsubdata/example.jsonl)")

    print(f"\n>>> FUSE mounted at: {mp}")
    print(">>> Open another terminal and run:")
    print(f">>>   ls {mp}/data/")
    print(f">>>   ls {mp}/deep/")
    print(f">>>   cat {mp}/deep/example.json")
    print(">>> Press Enter to unmount and exit...")
    try:
        input()
    except EOFError:
        pass

    records = ws.ops.records
    total = sum(r.bytes for r in records)
    print(f"\nStats: {len(records)} ops, {total} bytes transferred")
