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
import json
import os

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.resource.langfuse import LangfuseConfig, LangfuseResource

load_dotenv(".env.development")

config = LangfuseConfig(
    public_key=os.environ["LANGFUSE_PUBLIC_KEY"],
    secret_key=os.environ["LANGFUSE_SECRET_KEY"],
    host=os.environ["LANGFUSE_HOST"],
)
resource = LangfuseResource(config=config)


async def main():
    with Workspace({"/langfuse/": resource}, mode=MountMode.READ) as ws:
        print("=== VFS MODE: open() reads from Langfuse ===\n")

        print("--- os.listdir() top-level ---")
        top_level = os.listdir("/langfuse")
        for entry in top_level:
            print(f"  {entry}")

        print("\n--- os.listdir() traces ---")
        traces = os.listdir("/langfuse/traces")
        for t in traces[:5]:
            print(f"  {t}")
        if len(traces) > 5:
            print(f"  ... ({len(traces)} total)")

        if not traces:
            print("  no traces found")
            return

        first_trace = traces[0]
        path = f"/langfuse/traces/{first_trace}"
        print(f"\n--- open() + read {first_trace} ---")
        with open(path) as f:
            content = f.read()
        try:
            doc = json.loads(content)
            print(f"  name: {doc.get('name', '?')}")
            print(f"  id: {doc.get('id', '?')}")
            sid = doc.get("sessionId", doc.get("session_id", "?"))
            print(f"  session_id: {sid}")
        except json.JSONDecodeError:
            for line in content.splitlines()[:5]:
                print(f"  {line[:120]}")

        print("\n--- os.listdir() sessions ---")
        sessions = os.listdir("/langfuse/sessions")
        for s in sessions:
            print(f"  {s}")

        print("\n--- os.listdir() prompts ---")
        prompts = os.listdir("/langfuse/prompts")
        for p in prompts:
            print(f"  {p}")

        print("\n--- os.listdir() datasets ---")
        datasets = os.listdir("/langfuse/datasets")
        for d in datasets:
            print(f"  {d}")

        if datasets:
            ds = datasets[0]
            print(f"\n--- os.listdir() datasets/{ds} ---")
            items = os.listdir(f"/langfuse/datasets/{ds}")
            for item in items:
                print(f"  {item}")

        print("\n--- bash history ---")
        with open("/.bash_history") as f:
            for i, line in enumerate(f):
                if i >= 6:
                    break
                print(f"  {line.rstrip()[:120]}")

        records = ws.fs.records
        total = sum(r.bytes for r in records)
        print(f"\nStats: {len(records)} ops, "
              f"{total} bytes transferred")


asyncio.run(main())
