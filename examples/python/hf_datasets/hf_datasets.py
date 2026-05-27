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
from mirage.resource.hf_datasets import HfDatasetsConfig, HfDatasetsResource

load_dotenv(".env.development")

config = HfDatasetsConfig(
    repo_id=os.environ.get("HF_DATASET_REPO",
                           "AlienKevin/SWE-ZERO-12M-trajectories"),
    token=os.environ.get("HF_TOKEN"),
)
resource = HfDatasetsResource(config)
ws = Workspace({"/ds/": resource}, mode=MountMode.READ)


def ops_summary() -> str:
    records = ws.ops.records
    total = sum(r.bytes for r in records)
    return f"{len(records)} ops, {total} bytes transferred"


async def main():
    print(f"=== mounted {resource.accessor.bucket_uri} at /ds/ ===")

    print("\n=== ls /ds/ (one HTTP list, no file content) ===")
    r = await ws.execute("ls /ds/")
    print(await r.stdout_str())

    print("=== tree /ds/ ===")
    r = await ws.execute("tree -L 2 /ds/")
    print(await r.stdout_str())

    print("=== cat /ds/README.md | head -n 20 ===")
    r = await ws.execute("cat /ds/README.md | head -n 20")
    print(await r.stdout_str())

    print("=== find /ds/ -name '*.parquet' | head -n 5 ===")
    r = await ws.execute("find /ds/ -name '*.parquet' | head -n 5")
    print(await r.stdout_str())

    print(f"\nStats: {ops_summary()}")


if __name__ == "__main__":
    asyncio.run(main())
