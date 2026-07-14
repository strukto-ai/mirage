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
from mirage.resource.minio import MinIOConfig, MinIOResource
from mirage.types import PathSpec

load_dotenv(".env.development")

config = MinIOConfig(
    bucket=os.environ.get("MINIO_BUCKET", "mirage-demo"),
    endpoint_url=os.environ.get("MINIO_ENDPOINT", "http://localhost:9000"),
    access_key_id=os.environ.get("MINIO_ACCESS_KEY", "minioadmin"),
    secret_access_key=os.environ.get("MINIO_SECRET_KEY", "minioadmin"),
)
resource = MinIOResource(config)
ws = Workspace({"/minio/": resource}, mode=MountMode.WRITE)


def ops_summary() -> str:
    records = ws.ops.records
    total = sum(r.bytes for r in records)
    return f"{len(records)} ops, {total} bytes transferred"


async def main():
    print(f"=== MinIO at {config.endpoint_url} (bucket {config.bucket}) ===")

    # Seed a few objects so the demo is self-contained (WRITE mode).
    await ws.ops.write(
        "/minio/data/example.jsonl",
        b'{"event":"queue-operation","tool":"mirage"}\n'
        b'{"event":"read","tool":"mirage"}\n'
        b'{"event":"queue-operation","tool":"other"}\n')
    await ws.ops.write("/minio/data/config.json",
                       b'{"name":"mirage","version":1,"tags":["s3","minio"]}')
    await ws.ops.write("/minio/notes.txt", b"hello from minio\n")

    # chmod/chown/touch never hit the MinIO API: attrs land in the
    # workspace namespace (durable, snapshot-captured) and merge into
    # dispatch-level stat.
    print("=== metadata overlay on /minio/notes.txt ===")
    meta_res = await ws.execute('chmod 640 "/minio/notes.txt"'
                                ' && chown 500:dev "/minio/notes.txt"'
                                ' && touch -t 202601021530 "/minio/notes.txt"')
    print(f"  chmod/chown/touch exit={meta_res.exit_code}")
    meta_st, _ = await ws.dispatch("stat",
                                   PathSpec.from_str_path("/minio/notes.txt"))
    print(f"  dispatch stat: mode={oct(meta_st.mode)[2:]} uid={meta_st.uid} "
          f"gid={meta_st.gid} mtime={meta_st.modified}")

    print("\n--- ls /minio/ ---")
    r = await ws.execute("ls /minio/")
    print(await r.stdout_str())

    print("--- tree /minio/ ---")
    r = await ws.execute("tree /minio/")
    print(await r.stdout_str())

    print("--- stat /minio/notes.txt ---")
    r = await ws.execute("stat /minio/notes.txt")
    print(f"  {(await r.stdout_str()).strip()}")

    print("\n--- cat /minio/notes.txt ---")
    r = await ws.execute("cat /minio/notes.txt")
    print(f"  {(await r.stdout_str()).strip()!r}")

    print("\n--- head -c 40 /minio/data/example.jsonl (byte range) ---")
    r = await ws.execute("head -c 40 /minio/data/example.jsonl")
    print(f"  {(await r.stdout_str()).strip()!r}")

    print("\n--- grep -c queue-operation /minio/data/example.jsonl ---")
    r = await ws.execute("grep -c queue-operation /minio/data/example.jsonl")
    print(f"  count: {(await r.stdout_str()).strip()}")

    print("--- find /minio/ -name '*.json' ---")
    r = await ws.execute("find /minio/ -name '*.json'")
    print(await r.stdout_str())

    print("--- jq .tags /minio/data/config.json ---")
    r = await ws.execute("jq .tags /minio/data/config.json")
    print(f"  {(await r.stdout_str()).strip()}")

    print("\n--- PROVISION: cat (plan only) vs head -c (byte budget) ---")
    dr = await ws.execute("cat /minio/data/example.jsonl", provision=True)
    print(f"  cat: network_read={dr.network_read} precision={dr.precision}")
    dr = await ws.execute("head -c 20 /minio/data/example.jsonl",
                          provision=True)
    print(f"  head -c 20: network_read={dr.network_read} "
          f"precision={dr.precision}")

    print("\n--- rm seeded objects ---")
    for key in ("/minio/data/example.jsonl", "/minio/data/config.json",
                "/minio/notes.txt"):
        await ws.execute(f"rm {key}")
    print("  cleaned")

    print(f"\nStats: {ops_summary()}")


if __name__ == "__main__":
    asyncio.run(main())
