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
from mirage.resource.hf_models import HfModelsConfig, HfModelsResource

load_dotenv(".env.development")

config = HfModelsConfig(
    repo_id=os.environ.get("HF_MODEL_REPO", "sapientinc/HRM-Text-1B"),
    token=os.environ.get("HF_TOKEN"),
)
resource = HfModelsResource(config)
ws = Workspace({"/m/": resource}, mode=MountMode.READ)


def ops_summary() -> str:
    records = ws.ops.records
    total = sum(r.bytes for r in records)
    return f"{len(records)} ops, {total} bytes transferred"


async def main():
    print(f"=== mounted {resource.accessor.bucket_uri} at /m/ ===")

    print("\n=== ls /m/ ===")
    r = await ws.execute("ls /m/")
    print(await r.stdout_str())

    print("=== ls -lh /m/ (sizes; weights stay remote) ===")
    r = await ws.execute("ls -lh /m/")
    print(await r.stdout_str())

    print("=== cat /m/config.json ===")
    r = await ws.execute("cat /m/config.json")
    print(await r.stdout_str())

    print("=== find /m/ -name '*.safetensors' ===")
    r = await ws.execute("find /m/ -name '*.safetensors'")
    print(await r.stdout_str())

    print(f"\nStats: {ops_summary()}")
    print("(weights never downloaded; only config + listings transferred)")


if __name__ == "__main__":
    asyncio.run(main())
