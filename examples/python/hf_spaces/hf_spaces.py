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
from mirage.resource.hf_spaces import HfSpacesConfig, HfSpacesResource

load_dotenv(".env.development")

config = HfSpacesConfig(
    repo_id=os.environ.get("HF_SPACE_REPO", "HuggingFaceBio/carbon-demo"),
    token=os.environ.get("HF_TOKEN"),
)
resource = HfSpacesResource(config)
ws = Workspace({"/s/": resource}, mode=MountMode.READ)


def ops_summary() -> str:
    records = ws.ops.records
    total = sum(r.bytes for r in records)
    return f"{len(records)} ops, {total} bytes transferred"


async def main():
    print(f"=== mounted {resource.accessor.bucket_uri} at /s/ ===")

    print("\n=== ls /s/ ===")
    r = await ws.execute("ls /s/")
    print(await r.stdout_str())

    print("=== cat /s/README.md | head -n 20 ===")
    r = await ws.execute("cat /s/README.md | head -n 20")
    print(await r.stdout_str())

    print("=== find /s/ -name '*.py' | head -n 5 ===")
    r = await ws.execute("find /s/ -name '*.py' | head -n 5")
    print(await r.stdout_str())

    print("=== grep -l import /s/*.py 2>/dev/null ===")
    r = await ws.execute("grep -l import /s/*.py 2>/dev/null")
    print(await r.stdout_str())

    print(f"\nStats: {ops_summary()}")


if __name__ == "__main__":
    asyncio.run(main())
