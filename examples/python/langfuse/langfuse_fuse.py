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

import json
import os

from dotenv import load_dotenv

from mirage import Mount, MountMode, Workspace
from mirage.resource.langfuse import LangfuseConfig, LangfuseResource

load_dotenv(".env.development")

config = LangfuseConfig(
    public_key=os.environ["LANGFUSE_PUBLIC_KEY"],
    secret_key=os.environ["LANGFUSE_SECRET_KEY"],
    host=os.environ["LANGFUSE_HOST"],
)
resource = LangfuseResource(config=config)

with Workspace({"/langfuse/": Mount(resource, mode=MountMode.READ,
                                    fuse=True)}) as ws:
    mp = ws.fuse_mountpoint

    print(f"=== FUSE MODE: mounted at {mp} ===\n")

    print("--- os.listdir() top-level ---")
    top_level = os.listdir(mp)
    for entry in top_level:
        print(f"  {entry}")

    if not top_level:
        print("  no entries found")
    else:
        print("\n--- os.listdir() traces ---")
        traces = os.listdir(f"{mp}/traces")
        for t in traces[:5]:
            print(f"  {t}")
        if len(traces) > 5:
            print(f"  ... ({len(traces)} total)")

        if traces:
            first_trace = traces[0]
            path = f"{mp}/traces/{first_trace}"
            print(f"\n--- open() + read {first_trace} ---")
            with open(path) as f:
                content = f.read().strip()
            if content:
                try:
                    doc = json.loads(content)
                    print(f"  name: {doc.get('name', '?')}")
                    print(f"  id: {doc.get('id', '?')}")
                except json.JSONDecodeError:
                    for line in content.splitlines()[:5]:
                        print(f"  {line[:120]}")
            else:
                print("  (empty)")

        print("\n--- os.listdir() prompts ---")
        prompts = os.listdir(f"{mp}/prompts")
        for p in prompts:
            print(f"  {p}")

        print("\n--- os.listdir() datasets ---")
        datasets = os.listdir(f"{mp}/datasets")
        for d in datasets:
            print(f"  {d}")

    print(f"\n>>> FUSE mounted at: {mp}")
    print(">>> Open another terminal and run:")
    print(f">>>   ls {mp}/")
    print(f">>>   cat {mp}/traces/<trace-id>.json")
    print(">>> Press Enter to unmount and exit...")
    input()

    records = ws.ops.records
    total = sum(r.bytes for r in records)
    print(f"\nStats: {len(records)} ops, "
          f"{total} bytes transferred")
