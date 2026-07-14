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
from mirage.resource.qingstor import QingStorConfig, QingStorResource
from mirage.types import PathSpec

load_dotenv(".env.development")

# NOTE: QingStor's S3-compatible endpoint is less standardized than the other
# providers. If the derived endpoint (s3.<zone>.qingstor.com) does not work,
# set QINGSTOR_ENDPOINT_URL explicitly.
config = QingStorConfig(
    bucket=os.environ["QINGSTOR_BUCKET"],
    region=os.environ.get("QINGSTOR_ZONE", "pek3a"),
    endpoint_url=os.environ.get("QINGSTOR_ENDPOINT_URL"),
    access_key_id=os.environ["QINGSTOR_ACCESS_KEY_ID"],
    secret_access_key=os.environ["QINGSTOR_SECRET_ACCESS_KEY"],
)
resource = QingStorResource(config)
ws = Workspace({"/qs/": resource}, mode=MountMode.READ)


def ops_summary() -> str:
    records = ws.ops.records
    return f"{len(records)} ops, {sum(r.bytes for r in records)} bytes"


async def main():
    print(f"=== QingStor at {config.resolved_endpoint_url()} ===")

    r = await ws.execute("ls /qs/")
    print("ls /qs/:\n" + await r.stdout_str())

    r = await ws.execute("find /qs/ -name '*.json' | head -n 5")
    print("find *.json:\n" + await r.stdout_str())

    r = await ws.execute("grep -m 1 mirage /qs/data/example.jsonl",
                         provision=True)
    print(f"plan grep -m 1: network_read={r.network_read} "
          f"precision={r.precision}")

    print(f"\nStats: {ops_summary()}")

    # chmod/chown/touch never hit the QingStor API: attrs land in the
    # workspace namespace (durable, snapshot-captured) and merge into
    # dispatch-level stat.
    print("=== metadata overlay on /qs/data/example.jsonl ===")
    meta_res = await ws.execute(
        'chmod 640 "/qs/data/example.jsonl"'
        ' && chown 500:dev "/qs/data/example.jsonl"'
        ' && touch -t 202601021530 "/qs/data/example.jsonl"')
    print(f"  chmod/chown/touch exit={meta_res.exit_code}")
    meta_st, _ = await ws.dispatch(
        "stat", PathSpec.from_str_path("/qs/data/example.jsonl"))
    print(f"  dispatch stat: mode={oct(meta_st.mode)[2:]} uid={meta_st.uid} "
          f"gid={meta_st.gid} mtime={meta_st.modified}")


if __name__ == "__main__":
    asyncio.run(main())
