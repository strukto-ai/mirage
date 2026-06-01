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
from mirage.resource.hf_datasets import HfDatasetsConfig, HfDatasetsResource

load_dotenv(".env.development")

config = HfDatasetsConfig(
    repo_id=os.environ.get("HF_DATASET_REPO",
                           "AlienKevin/SWE-ZERO-12M-trajectories"),
    token=os.environ.get("HF_TOKEN"),
)
resource = HfDatasetsResource(config)


async def main():
    with Workspace({"/ds/": resource}, mode=MountMode.READ) as ws:
        vos = sys.modules["os"]
        print(f"=== VFS: {resource.accessor.bucket_uri} ===")

        print("\n--- os.listdir('/ds') ---")
        root_entries = vos.listdir("/ds")
        for e in root_entries:
            print(f"  {e}")

        if "README.md" in root_entries:
            print("\n--- read first 5 lines of /ds/README.md ---")
            with open("/ds/README.md") as f:
                for i, line in enumerate(f):
                    if i >= 5:
                        break
                    print(f"  [{i}] {line.rstrip()[:100]}")

        if "data" in root_entries and vos.path.isdir("/ds/data"):
            print("\n--- os.listdir('/ds/data') (first 5) ---")
            for e in vos.listdir("/ds/data")[:5]:
                print(f"  {e}")

        print("\n--- shell view ---")
        r = await ws.execute("ls /ds/")
        print(f"  ls /ds/: {(await r.stdout_str()).strip()}")
        r = await ws.execute("find /ds/ -name '*.parquet' | head -n 3")
        print(f"  parquet shards (first 3): {(await r.stdout_str()).strip()}")


asyncio.run(main())
