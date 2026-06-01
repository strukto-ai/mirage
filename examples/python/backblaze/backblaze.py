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
from mirage.resource.backblaze import BackblazeConfig, BackblazeResource

load_dotenv(".env.development")

config = BackblazeConfig(
    bucket=os.environ["B2_BUCKET"],
    region=os.environ["B2_REGION"],  # e.g. us-west-004
    access_key_id=os.environ["B2_ACCESS_KEY_ID"],  # keyID
    secret_access_key=os.environ["B2_SECRET_ACCESS_KEY"],  # applicationKey
)
resource = BackblazeResource(config)
ws = Workspace({"/b2/": resource}, mode=MountMode.READ)


def ops_summary() -> str:
    records = ws.ops.records
    return f"{len(records)} ops, {sum(r.bytes for r in records)} bytes"


async def main():
    print(f"=== Backblaze B2 at {config.resolved_endpoint_url()} ===")

    r = await ws.execute("ls /b2/")
    print("ls /b2/:\n" + await r.stdout_str())

    r = await ws.execute("find /b2/ -name '*.json' | head -n 5")
    print("find *.json:\n" + await r.stdout_str())

    r = await ws.execute("grep -m 1 mirage /b2/data/example.jsonl",
                         provision=True)
    print(f"plan grep -m 1: network_read={r.network_read} "
          f"precision={r.precision}")

    print(f"\nStats: {ops_summary()}")


if __name__ == "__main__":
    asyncio.run(main())
