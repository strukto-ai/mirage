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
import copy as _copy
import os
import tempfile
import uuid

from mirage import MountMode, Workspace
from mirage.commands.builtin.redis._provision import (file_read_provision,
                                                      head_tail_provision,
                                                      metadata_provision)
from mirage.resource.redis import RedisResource
from mirage.types import PathSpec

REDIS_URL = "redis://localhost:6379/0"
resource = RedisResource(url=REDIS_URL)


async def main() -> None:
    ws = Workspace({"/data": resource}, mode=MountMode.WRITE)

    print("=== tee (create files) ===")
    await ws.execute('echo "hello world" | tee /data/hello.txt')
    await ws.execute(
        'echo \'{"name": "alice", "age": 30}\' | tee /data/user.json')
    await ws.execute("mkdir /data/reports")
    await ws.execute(
        'echo "revenue,100\\nexpense,80" | tee /data/reports/q1.csv')

    print("=== ls /data/ ===")
    result = await ws.execute("ls /data/")
    print(await result.stdout_str())

    print("=== cat /data/hello.txt ===")
    result = await ws.execute("cat /data/hello.txt")
    print(await result.stdout_str())

    print("=== head -n 1 /data/reports/q1.csv ===")
    result = await ws.execute("head -n 1 /data/reports/q1.csv")
    print(await result.stdout_str())

    print("=== tail -n 1 /data/reports/q1.csv ===")
    result = await ws.execute("tail -n 1 /data/reports/q1.csv")
    print(await result.stdout_str())

    print("=== wc /data/hello.txt ===")
    result = await ws.execute("wc /data/hello.txt")
    print(await result.stdout_str())

    print("=== stat /data/hello.txt ===")
    result = await ws.execute("stat /data/hello.txt")
    print(await result.stdout_str())

    print("=== jq .name /data/user.json ===")
    result = await ws.execute('jq ".name" /data/user.json')
    print(await result.stdout_str())

    print("=== nl /data/reports/q1.csv ===")
    result = await ws.execute("nl /data/reports/q1.csv")
    print(await result.stdout_str())

    print("=== tree /data/ ===")
    result = await ws.execute("tree /data/")
    print(await result.stdout_str())

    print("=== find /data/ -name '*.txt' ===")
    result = await ws.execute("find /data/ -name '*.txt'")
    print(await result.stdout_str())

    print("=== grep hello /data/hello.txt ===")
    result = await ws.execute("grep hello /data/hello.txt")
    print(await result.stdout_str())

    print("=== rg hello /data/hello.txt ===")
    result = await ws.execute("rg hello /data/hello.txt")
    print(await result.stdout_str())

    print("=== basename /data/hello.txt ===")
    result = await ws.execute("basename /data/hello.txt")
    print(await result.stdout_str())

    print("=== dirname /data/hello.txt ===")
    result = await ws.execute("dirname /data/hello.txt")
    print(await result.stdout_str())

    print("=== realpath /data/hello.txt ===")
    result = await ws.execute("realpath /data/hello.txt")
    print(await result.stdout_str())

    print("=== sort /data/reports/q1.csv ===")
    result = await ws.execute("sort /data/reports/q1.csv")
    print(await result.stdout_str())

    print("=== tr a-z A-Z < /data/hello.txt ===")
    result = await ws.execute("cat /data/hello.txt | tr a-z A-Z")
    print(await result.stdout_str())

    print("=== cp /data/hello.txt /data/hello_copy.txt ===")
    await ws.execute("cp /data/hello.txt /data/hello_copy.txt")
    result = await ws.execute("cat /data/hello_copy.txt")
    print(await result.stdout_str())

    print("=== mv /data/hello_copy.txt /data/renamed.txt ===")
    await ws.execute("mv /data/hello_copy.txt /data/renamed.txt")
    result = await ws.execute("ls /data/")
    print(await result.stdout_str())

    print("=== rm /data/renamed.txt ===")
    await ws.execute("rm /data/renamed.txt")
    result = await ws.execute("ls /data/")
    print(await result.stdout_str())

    print("=== du /data/ ===")
    result = await ws.execute("du /data/")
    print(await result.stdout_str())

    print("=== sed ===")
    result = await ws.execute("cat /data/hello.txt | sed s/hello/goodbye/")
    print(await result.stdout_str())

    print("=== awk ===")
    result = await ws.execute("cat /data/reports/q1.csv | awk -F, '{print $1}'"
                              )
    print(await result.stdout_str())

    print("=== uniq ===")
    await ws.execute('echo "a\\na\\nb\\nb\\nc" | tee /data/dup.txt')
    result = await ws.execute("sort /data/dup.txt | uniq")
    print(await result.stdout_str())

    print("=== rev ===")
    result = await ws.execute("cat /data/hello.txt | rev")
    print(await result.stdout_str())

    print("=== md5 /data/hello.txt ===")
    result = await ws.execute("md5 /data/hello.txt")
    print(await result.stdout_str())

    print("=== base64 /data/hello.txt ===")
    result = await ws.execute("base64 /data/hello.txt")
    print(await result.stdout_str())

    # ── provision: cost estimates before execution ─────────────────
    print("\n=== PROVISION (cost estimates before execution) ===\n")
    print(
        "  Redis ops have no ranged GET — every read fetches the full value.")
    print("  Provision lets the agent budget IO / compute before running.\n")

    # 1. ws.execute(cmd, provision=True) returns a ProvisionResult
    ws_prov = await ws.execute("cat /data/hello.txt", provision=True)
    print("  ws.execute('cat /data/hello.txt', provision=True):")
    print(f"    command        = {ws_prov.command!r}")
    print(f"    network_read   = {ws_prov.network_read}")
    print(f"    read_ops       = {ws_prov.read_ops}")
    print(f"    precision      = {ws_prov.precision}")
    print()

    # 2. Redis-specific helpers — exact Redis cost, callable standalone
    paths = [
        PathSpec(original="/data/hello.txt", directory="/data",
                 prefix="/data"),
        PathSpec(original="/data/user.json", directory="/data",
                 prefix="/data"),
    ]
    accessor = resource.accessor

    read_cost = await file_read_provision(accessor, paths, command="cat")
    print("  file_read_provision(accessor, [hello.txt, user.json]):")
    print(f"    network_read   = {read_cost.network_read} bytes "
          f"({read_cost.read_ops} reads)")
    print(f"    precision      = {read_cost.precision}")

    head_cost = await head_tail_provision(accessor, paths, command="head -n 1")
    print("  head_tail_provision(...) — Redis fetches full value regardless:")
    print(f"    network_read   = {head_cost.network_read} bytes")

    meta_cost = await metadata_provision(accessor, paths, command="stat")
    print("  metadata_provision(...) — stat/ls/find cost zero network bytes:")
    print(f"    network_read   = {meta_cost.network_read} bytes")
    print(f"    read_ops       = {meta_cost.read_ops}")

    # ── persistence: save / load / copy / deepcopy ──────────────────
    # Redis has redacted connection config: saved state contains the full
    # key+value dump, but caller must supply a fresh RedisResource (often
    # pointed at a different
    # Redis instance / different key prefix) at load time.
    print("\n=== PERSISTENCE ===\n")
    with tempfile.NamedTemporaryFile(suffix=".tar", delete=False) as f:
        snap = f.name
    dst_prefix = f"mirage:loaded:{uuid.uuid4().hex[:8]}:"
    try:
        await ws.snapshot(snap)
        print(f"  saved → {snap} ({os.path.getsize(snap)} bytes)")

        try:
            Workspace.load(snap)
            print("  ✗ load() should have raised without resources=")
        except ValueError as e:
            print(f"  ✓ load() w/o resources raises: "
                  f"{str(e).splitlines()[0][:70]}…")

        # Load into a fresh Redis prefix (same instance, isolated namespace)
        loaded = Workspace.load(snap,
                                resources={
                                    "/data":
                                    RedisResource(url=REDIS_URL,
                                                  key_prefix=dst_prefix)
                                })
        r = await loaded.execute("ls /data/")
        print(f"  loaded ws ls /data: "
              f"{(await r.stdout_str()).strip()[:60]}…")

        # copy(): in-process, reuses same RedisResource, both copies
        # see the same Redis state
        cp = await ws.copy()
        print(f"  copy() mounts: {[m.prefix for m in cp.mounts()]}")

        for op_name, op in (("deepcopy", _copy.deepcopy), ("shallow copy",
                                                           _copy.copy)):
            try:
                op(ws)
                print(f"  ✗ {op_name} should have raised")
            except NotImplementedError as e:
                print(f"  ✓ {op_name} raises: {str(e)[:60]}…")
    finally:
        os.unlink(snap)
        # Cleanup loaded keys
        import redis as sync_redis
        sc = sync_redis.Redis.from_url(REDIS_URL)
        for key in sc.scan_iter(f"{dst_prefix}*"):
            sc.delete(key)
        sc.close()


if __name__ == "__main__":
    asyncio.run(main())
