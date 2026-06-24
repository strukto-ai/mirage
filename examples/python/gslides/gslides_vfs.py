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
import sys

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.resource.gslides import GSlidesConfig, GSlidesResource

load_dotenv(".env.development")

config = GSlidesConfig(
    client_id=os.environ["GOOGLE_CLIENT_ID"],
    client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
    refresh_token=os.environ["GOOGLE_REFRESH_TOKEN"],
)
resource = GSlidesResource(config=config)


async def main() -> None:
    with Workspace({"/gslides/": resource}, mode=MountMode.READ) as ws:
        vos = sys.modules["os"]
        print(
            "=== VFS MODE: open() reads from Google Slides transparently ===\n"
        )

        print("--- os.listdir() root ---")
        dirs = vos.listdir("/gslides")
        for d in dirs:
            print(f"  {d}")

        print("\n--- os.listdir() owned ---")
        presentations = vos.listdir("/gslides/owned")
        for p in presentations[:5]:
            print(f"  {p}")

        if presentations:
            first = presentations[0]
            path = f"/gslides/owned/{first}"
            print("\n--- open() + read first presentation ---")
            with open(path) as f:
                content = f.read()
                parsed = json.loads(content)
                title = parsed.get("title", "N/A")
                num_slides = len(parsed.get("slides", []))
                print(f"  title: {title}")
                print(f"  slides: {num_slides}")
                print(f"  preview: {content[:200]}...")

            print("\n--- os.path.exists() ---")
            print(f"  {first}: {vos.path.exists(path)}")
            print(
                f"  nonexistent: {vos.path.exists('/gslides/owned/nope.json')}"
            )

        print("\n--- bash history ---")
        with open("/.bash_history") as f:
            for i, line in enumerate(f):
                if i >= 6:
                    break
                print(f"  {line.rstrip()[:120]}")

        records = ws.ops.records
        total = sum(r.bytes for r in records)
        print(f"\nStats: {len(records)} ops, {total} bytes transferred")


asyncio.run(main())
