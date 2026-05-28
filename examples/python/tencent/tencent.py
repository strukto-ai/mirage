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
from mirage.resource.tencent import TencentConfig, TencentResource

load_dotenv(".env.development")

config = TencentConfig(
    bucket=os.environ["COS_BUCKET"],  # name-APPID, e.g. my-bucket-1250000000
    region=os.environ["COS_REGION"],  # e.g. ap-guangzhou
    access_key_id=os.environ["COS_SECRET_ID"],
    secret_access_key=os.environ["COS_SECRET_KEY"],
)
resource = TencentResource(config)
ws = Workspace({"/cos/": resource}, mode=MountMode.READ)


def ops_summary() -> str:
    records = ws.ops.records
    return f"{len(records)} ops, {sum(r.bytes for r in records)} bytes"


async def main():
    print(f"=== Tencent COS at {config.resolved_endpoint_url()} ===")

    r = await ws.execute("ls /cos/")
    print("ls /cos/:\n" + await r.stdout_str())

    r = await ws.execute("find /cos/ -name '*.json' | head -n 5")
    print("find *.json:\n" + await r.stdout_str())

    r = await ws.execute("grep -m 1 mirage /cos/data/example.jsonl",
                         provision=True)
    print(f"plan grep -m 1: network_read={r.network_read} "
          f"precision={r.precision}")

    print(f"\nStats: {ops_summary()}")


if __name__ == "__main__":
    asyncio.run(main())
