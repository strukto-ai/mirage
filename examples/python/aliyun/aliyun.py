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
from mirage.resource.aliyun import AliyunConfig, AliyunResource

load_dotenv(".env.development")

config = AliyunConfig(
    bucket=os.environ["OSS_BUCKET"],
    region=os.environ["OSS_REGION"],  # e.g. cn-hangzhou
    access_key_id=os.environ["OSS_ACCESS_KEY_ID"],
    secret_access_key=os.environ["OSS_ACCESS_KEY_SECRET"],
)
resource = AliyunResource(config)
ws = Workspace({"/oss/": resource}, mode=MountMode.READ)


def ops_summary() -> str:
    records = ws.ops.records
    return f"{len(records)} ops, {sum(r.bytes for r in records)} bytes"


async def main():
    print(f"=== Alibaba OSS at {config.resolved_endpoint_url()} ===")

    r = await ws.execute("ls /oss/")
    print("ls /oss/:\n" + await r.stdout_str())

    r = await ws.execute("find /oss/ -name '*.json' | head -n 5")
    print("find *.json:\n" + await r.stdout_str())

    r = await ws.execute("grep -m 1 mirage /oss/data/example.jsonl",
                         provision=True)
    print(f"plan grep -m 1: network_read={r.network_read} "
          f"precision={r.precision}")

    print(f"\nStats: {ops_summary()}")


if __name__ == "__main__":
    asyncio.run(main())
