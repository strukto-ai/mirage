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
from mirage.resource.hf_spaces import HfSpacesConfig, HfSpacesResource

load_dotenv(".env.development")

config = HfSpacesConfig(
    repo_id=os.environ.get("HF_SPACE_REPO", "HuggingFaceBio/carbon-demo"),
    token=os.environ.get("HF_TOKEN"),
)
resource = HfSpacesResource(config)


async def main():
    with Workspace({"/s/": resource}, mode=MountMode.READ) as ws:
        vos = sys.modules["os"]
        print(f"=== VFS: {resource.accessor.bucket_uri} ===")

        print("\n--- os.listdir('/s') ---")
        root_entries = vos.listdir("/s")
        for e in root_entries:
            print(f"  {e}")

        if "README.md" in root_entries:
            print("\n--- read first 8 lines of /s/README.md ---")
            with open("/s/README.md") as f:
                for i, line in enumerate(f):
                    if i >= 8:
                        break
                    print(f"  [{i}] {line.rstrip()[:120]}")

        if "requirements.txt" in root_entries:
            print("\n--- /s/requirements.txt ---")
            with open("/s/requirements.txt") as f:
                print(f.read().rstrip())

        print("\n--- shell view ---")
        r = await ws.execute("find /s/ -name '*.py' | head -n 5")
        print(f"  python files: {(await r.stdout_str()).strip()}")


asyncio.run(main())
