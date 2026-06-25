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
from mirage.resource.hf_spaces import HfSpacesConfig, HfSpacesResource

load_dotenv(".env.development")

config = HfSpacesConfig(
    repo_id=os.environ.get("HF_SPACE_REPO", "HuggingFaceBio/carbon-demo"),
    token=os.environ.get("HF_TOKEN"),
)
resource = HfSpacesResource(config)

with Workspace({"/s/": Mount(resource, mode=MountMode.READ, fuse=True)}) as ws:
    mp = ws.fuse_mountpoint
    print(f"=== FUSE: mounted at {mp} ===\n")

    print(f"--- os.listdir({mp}) ---")
    root_entries = os.listdir(mp)
    for e in root_entries:
        print(f"  {e}")

    readme = f"{mp}/README.md"
    if os.path.exists(readme):
        size = os.path.getsize(readme)
        print(f"\n--- {readme} ({size} bytes), first 5 lines ---")
        with open(readme) as f:
            for i, line in enumerate(f):
                if i >= 5:
                    break
                print(f"  [{i}] {line.rstrip()[:120]}")

    print(f"\n>>> FUSE mounted at: {mp}")
    print(">>> In another terminal:")
    print(f">>>   ls {mp}/")
    print(f">>>   cat {mp}/README.md")
    print(">>> Press Enter to unmount...")
    try:
        input()
    except EOFError:
        pass

    records = ws.ops.records
    total = sum(r.bytes for r in records)
    print(f"\nStats: {len(records)} ops, {total} bytes transferred")
