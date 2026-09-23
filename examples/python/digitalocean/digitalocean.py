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
from mirage.types import PathSpec
from mirage.vfs.digitalocean import DigitalOceanConfig, DigitalOceanVFS

load_dotenv(".env.development")

config = DigitalOceanConfig(
    bucket=os.environ["DO_SPACE"],
    region=os.environ["DO_REGION"],  # e.g. nyc3
    access_key_id=os.environ["DO_ACCESS_KEY_ID"],
    secret_access_key=os.environ["DO_SECRET_ACCESS_KEY"],
)
vfs = DigitalOceanVFS(config)
ws = Workspace({"/do/": vfs}, mode=MountMode.READ)


def ops_summary() -> str:
    records = ws.vfs.records
    return f"{len(records)} ops, {sum(r.bytes for r in records)} bytes"


async def main():
    print(f"=== DigitalOcean Spaces at {config.resolved_endpoint_url()} ===")

    r = await ws.shell("ls /do/")
    print("ls /do/:\n" + await r.stdout_str())

    r = await ws.shell("find /do/ -name '*.json' | head -n 5")
    print("find *.json:\n" + await r.stdout_str())

    r = await ws.shell("grep -m 1 mirage /do/data/example.jsonl",
                       provision=True)
    print(f"plan grep -m 1: network_read={r.network_read} "
          f"precision={r.precision}")

    print(f"\nStats: {ops_summary()}")

    # chmod/chown/touch never hit the Spaces API: attrs land in the
    # workspace namespace (durable, snapshot-captured) and merge into
    # dispatch-level stat.
    print("=== metadata overlay on /do/data/example.jsonl ===")
    meta_res = await ws.shell(
        'chmod 640 "/do/data/example.jsonl"'
        ' && chown 500:dev "/do/data/example.jsonl"'
        ' && touch -t 202601021530 "/do/data/example.jsonl"')
    print(f"  chmod/chown/touch exit={meta_res.exit_code}")
    meta_st, _ = await ws.dispatch(
        "stat", PathSpec.from_str_path("/do/data/example.jsonl"))
    print(f"  dispatch stat: mode={oct(meta_st.mode)[2:]} uid={meta_st.uid} "
          f"gid={meta_st.gid} mtime={meta_st.modified}")


if __name__ == "__main__":
    asyncio.run(main())
