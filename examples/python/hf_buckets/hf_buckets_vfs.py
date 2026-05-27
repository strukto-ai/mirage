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
import sys

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.resource.hf_buckets import HfBucketsConfig, HfBucketsResource

load_dotenv(".env.development")

config = HfBucketsConfig(
    bucket=os.environ["HF_BUCKET_NAME"],
    token=os.environ["HF_TOKEN"],
)
resource = HfBucketsResource(config)


async def main():
    with Workspace({"/hf/": resource}, mode=MountMode.READ) as ws:
        vos = sys.modules["os"]
        print("=== VFS: open() reads from HF Bucket transparently ===")

        print("\n--- os.listdir('/hf') ---")
        root_entries = vos.listdir("/hf")
        for e in root_entries:
            print(f"  {e}")

        data_dir = "/hf"
        if "data" in root_entries and vos.path.isdir("/hf/data"):
            data_dir = "/hf/data"
            print(f"\n--- os.listdir('{data_dir}') ---")
            for e in vos.listdir(data_dir):
                print(f"  {e}")

        entries = vos.listdir(data_dir)
        target = None
        for entry in entries:
            if entry.endswith(".jsonl") or entry.endswith(".json"):
                target = f"{data_dir}/{entry}"
                break

        if target:
            print(f"\n--- read first 3 lines of {target} ---")
            with open(target) as f:
                for i, line in enumerate(f):
                    if i >= 3:
                        break
                    print(f"  [{i}] {line.strip()[:100]}")

        print("\n--- VFS commands ---")
        r = await ws.execute(f"ls {data_dir}")
        print(f"  ls {data_dir}: {(await r.stdout_str()).strip()}")
        if target:
            r = await ws.execute(f"head -n 3 {target}")
            print(f"  head -n 3:\n{(await r.stdout_str()).rstrip()}")
            r = await ws.execute(f"wc -l {target}")
            print(f"  wc -l: {(await r.stdout_str()).strip()}")


asyncio.run(main())
