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

from mirage import MountMode, Workspace
from mirage.vfs.ram import RAMVFS

vfs = RAMVFS()


async def main() -> None:
    ws = Workspace({"/data": vfs}, mode=MountMode.WRITE)

    print("=== tee (create files) ===")
    await ws.shell('echo "hello world" | tee /data/hello.txt')
    await ws.shell(
        'echo \'{"name": "alice", "age": 30}\' | tee /data/user.json')
    await ws.shell("mkdir /data/reports")
    await ws.shell('echo "revenue,100\\nexpense,80" | tee /data/reports/q1.csv'
                   )

    print("=== ls /data/ ===")
    result = await ws.shell("ls /data/")
    print(await result.stdout_str())

    print("=== cat /data/hello.txt ===")
    result = await ws.shell("cat /data/hello.txt")
    print(await result.stdout_str())

    print("=== head -n 1 /data/reports/q1.csv ===")
    result = await ws.shell("head -n 1 /data/reports/q1.csv")
    print(await result.stdout_str())

    print("=== tail -n 1 /data/reports/q1.csv ===")
    result = await ws.shell("tail -n 1 /data/reports/q1.csv")
    print(await result.stdout_str())

    print("=== wc /data/hello.txt ===")
    result = await ws.shell("wc /data/hello.txt")
    print(await result.stdout_str())

    print("=== stat /data/hello.txt ===")
    result = await ws.shell("stat /data/hello.txt")
    print(await result.stdout_str())

    print("=== jq .name /data/user.json ===")
    result = await ws.shell('jq ".name" /data/user.json')
    print(await result.stdout_str())

    print("=== nl /data/reports/q1.csv ===")
    result = await ws.shell("nl /data/reports/q1.csv")
    print(await result.stdout_str())

    print("=== tree /data/ ===")
    result = await ws.shell("tree /data/")
    print(await result.stdout_str())

    print("=== find /data/ -name '*.txt' ===")
    result = await ws.shell("find /data/ -name '*.txt'")
    print(await result.stdout_str())

    print("=== grep hello /data/hello.txt ===")
    result = await ws.shell("grep hello /data/hello.txt")
    print(await result.stdout_str())

    print("=== rg hello /data/hello.txt ===")
    result = await ws.shell("rg hello /data/hello.txt")
    print(await result.stdout_str())

    print("=== basename /data/hello.txt ===")
    result = await ws.shell("basename /data/hello.txt")
    print(await result.stdout_str())

    print("=== dirname /data/hello.txt ===")
    result = await ws.shell("dirname /data/hello.txt")
    print(await result.stdout_str())

    print("=== realpath /data/hello.txt ===")
    result = await ws.shell("realpath /data/hello.txt")
    print(await result.stdout_str())

    print("=== sort /data/reports/q1.csv ===")
    result = await ws.shell("sort /data/reports/q1.csv")
    print(await result.stdout_str())

    print("=== tr a-z A-Z < /data/hello.txt ===")
    result = await ws.shell("cat /data/hello.txt | tr a-z A-Z")
    print(await result.stdout_str())

    print("=== cp /data/hello.txt /data/hello_copy.txt ===")
    await ws.shell("cp /data/hello.txt /data/hello_copy.txt")
    result = await ws.shell("cat /data/hello_copy.txt")
    print(await result.stdout_str())

    print("=== mv /data/hello_copy.txt /data/renamed.txt ===")
    await ws.shell("mv /data/hello_copy.txt /data/renamed.txt")
    result = await ws.shell("ls /data/")
    print(await result.stdout_str())

    print("=== rm /data/renamed.txt ===")
    await ws.shell("rm /data/renamed.txt")
    result = await ws.shell("ls /data/")
    print(await result.stdout_str())

    print("=== du /data/ ===")
    result = await ws.shell("du /data/")
    print(await result.stdout_str())

    print("=== sed ===")
    result = await ws.shell("cat /data/hello.txt | sed s/hello/goodbye/")
    print(await result.stdout_str())

    print("=== awk ===")
    result = await ws.shell("cat /data/reports/q1.csv | awk -F, '{print $1}'")
    print(await result.stdout_str())

    print("=== uniq ===")
    await ws.shell('echo "a\\na\\nb\\nb\\nc" | tee /data/dup.txt')
    result = await ws.shell("sort /data/dup.txt | uniq")
    print(await result.stdout_str())

    print("=== rev ===")
    result = await ws.shell("cat /data/hello.txt | rev")
    print(await result.stdout_str())

    print("=== md5 /data/hello.txt ===")
    result = await ws.shell("md5 /data/hello.txt")
    print(await result.stdout_str())

    print("=== base64 /data/hello.txt ===")
    result = await ws.shell("base64 /data/hello.txt")
    print(await result.stdout_str())

    print("\n=== METADATA (chmod / chown / touch) ===\n")
    print("=== chmod 640 + chown 500:staff + touch -t 202601021530 ===")
    await ws.shell("chmod 640 /data/hello.txt")
    await ws.shell("chown 500:staff /data/hello.txt")
    await ws.shell("touch -t 202601021530 /data/hello.txt")
    result = await ws.shell("ls -l /data/hello.txt")
    print(await result.stdout_str())

    print("=== chmod u+x,go-r (symbolic, composes on current mode) ===")
    await ws.shell("chmod u+x,go-r /data/hello.txt")
    result = await ws.shell("ls -l /data/hello.txt")
    print(await result.stdout_str())

    print("=== mv carries metadata ===")
    await ws.shell("mv /data/hello.txt /data/moved.txt")
    result = await ws.shell("ls -l /data/moved.txt")
    print(await result.stdout_str())
    await ws.shell("mv /data/moved.txt /data/hello.txt")

    print("=== touch -c missing.txt does not create ===")
    result = await ws.shell("touch -c /data/ghost.txt && ls /data/")
    print(await result.stdout_str())

    print("=== not-found errors show the full virtual path ===")
    for cmd in ("cat /data/missing.txt", "head /data/missing.txt",
                "stat /data/missing.txt"):
        result = await ws.shell(cmd)
        print(f"$ {cmd}")
        print(f"  exit={result.exit_code}  "
              f"{(await result.stderr_str()).strip()}")

    print("=== history (last 5) ===")
    result = await ws.shell("history 5")
    print(await result.stdout_str())

    print("\n=== /dev (auto-mounted synthetic devices) ===\n")
    print("=== ls /dev/ ===")
    result = await ws.shell("ls /dev/")
    print(await result.stdout_str())

    print("=== wc -c /dev/null ===")
    result = await ws.shell("wc -c /dev/null")
    print(await result.stdout_str())

    print("=== head -c 2M /dev/zero | wc -c ===")
    result = await ws.shell("head -c 2M /dev/zero | wc -c")
    print(await result.stdout_str())

    print("=== stat -c '%F %t %T' /dev/null ===")
    result = await ws.shell("stat -c '%F %t %T' /dev/null")
    print(await result.stdout_str())

    print("=== head -c 8 /dev/zero | xxd ===")
    result = await ws.shell("head -c 8 /dev/zero | xxd")
    print(await result.stdout_str())

    # ── provision: dry-run cost estimates (nothing executes) ────────
    # Read families estimate bytes from stat; pipes/&&/; sum, || takes
    # a min-max envelope, and writes report UNKNOWN.
    print("\n=== PROVISION (dry-run cost estimates) ===\n")
    for cmd in ("cat /data/hello.txt", "sort /data/hello.txt | head -n 1",
                "head /data/hello.txt || cat /data/hello.txt",
                "tee /data/out.txt"):
        plan = await ws.shell(cmd, provision=True)
        print(f"  {cmd}: net={plan.network_read} ops={plan.read_ops} "
              f"precision={plan.precision.value}")

    # ── persistence: save / load / copy / deepcopy ──────────────────
    # RAM has no redacted config: full content is in the snapshot, so
    # no mounts= needed at load time.
    print("\n=== PERSISTENCE ===\n")
    with tempfile.NamedTemporaryFile(suffix=".tar", delete=False) as f:
        snap = f.name
    try:
        await ws.snapshot(snap)
        print(f"  saved → {snap} ({os.path.getsize(snap)} bytes)")

        loaded = await Workspace.load(snap)
        r = await loaded.shell("cat /data/hello.txt")
        print(f"  loaded ws cat: {(await r.stdout_str()).strip()!r}")

        cp = await ws.copy()
        await cp.shell('echo "mutated" | tee /data/hello.txt')
        r_orig = await ws.shell("cat /data/hello.txt")
        r_cp = await cp.shell("cat /data/hello.txt")
        print(f"  original:  {(await r_orig.stdout_str()).strip()!r}")
        print(f"  copy:      {(await r_cp.stdout_str()).strip()!r}  "
              "(local backend → independent)")

        for op_name, op in (("deepcopy", _copy.deepcopy), ("shallow copy",
                                                           _copy.copy)):
            try:
                op(ws)
                print(f"  ✗ {op_name} should have raised")
            except NotImplementedError as e:
                print(f"  ✓ {op_name} raises: {str(e)[:60]}…")
    finally:
        os.unlink(snap)


if __name__ == "__main__":
    asyncio.run(main())
