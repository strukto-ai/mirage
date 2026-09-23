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

from mirage import MountMode, Workspace
from mirage.vfs.ram import RAMVFS


async def run(ws: Workspace, cmd: str) -> None:
    print(f"\n$ {cmd}")
    try:
        result = await ws.shell(cmd)
        out = (await result.stdout_str()).rstrip()
        if out:
            print(out)
        err = (await result.stderr_str()).rstrip()
        if err:
            print(f"stderr: {err}")
        if result.exit_code != 0:
            print(f"exit={result.exit_code}")
    except Exception as e:
        print(f"threw: {e}")


async def main() -> None:
    vfs = RAMVFS()
    ws = Workspace({"/data": vfs}, mode=MountMode.WRITE)

    def seed(path: str, data: bytes) -> None:
        vfs._store.files[path] = data

    seed("/dup.txt", b"banana\napple\ncherry\napple\n")
    seed("/sorted1.txt", b"apple\nbanana\ndate\n")
    seed("/sorted2.txt", b"banana\ncherry\ndate\n")
    seed("/tsv.txt", b"a\tb\tc\nfoo\t42\tbar\nhello\t7\tworld\n")
    seed("/csv.txt", b"1,alpha,x\n2,beta,y\n3,gamma,z\n")
    seed("/tabs.txt", b"\tfoo\n\t\tbar\n")
    seed(
        "/prose.txt",
        b"The quick brown fox jumps over the lazy dog. "
        b"The quick brown fox jumps over the lazy dog. "
        b"The quick brown fox jumps over the lazy dog.\n",
    )
    seed("/words.txt", b"apple\nant\nbanana\nberry\ncherry\n")
    seed("/join_a.txt", b"1 alpha\n2 beta\n3 gamma\n")
    seed("/join_b.txt", b"1 red\n2 green\n3 blue\n")
    seed("/deps.txt", b"a b\nb c\nc d\n")
    seed(
        "/binary.bin",
        bytes([
            0x00, 0x01, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x02, 0x77, 0x6f,
            0x72, 0x6c, 0x64, 0x00, 0xff
        ]),
    )

    print("━━━ column ━━━")
    await run(ws, "column -t /data/tsv.txt")

    print("\n━━━ comm (sorted1 vs sorted2) ━━━")
    await run(ws, "comm /data/sorted1.txt /data/sorted2.txt")

    print("\n━━━ expand / unexpand ━━━")
    await run(ws, "expand -t 4 /data/tabs.txt")
    await run(ws, "unexpand -t 4 /data/tsv.txt")

    print("\n━━━ fmt / fold ━━━")
    await run(ws, "fmt -w 40 /data/prose.txt")
    await run(ws, "fold -w 20 -s /data/prose.txt")

    print("\n━━━ iconv ━━━")
    await run(ws, "iconv -f utf-8 -t latin1 /data/sorted1.txt")

    print("\n━━━ join ━━━")
    await run(ws, "join /data/join_a.txt /data/join_b.txt")

    print("\n━━━ look ━━━")
    await run(ws, "look ban /data/words.txt")
    await run(ws, "look app /data/words.txt")

    print("\n━━━ mktemp ━━━")
    await run(ws, "mktemp -p /data")

    print("\n━━━ shuf / strings ━━━")
    await run(ws, "shuf /data/dup.txt")
    await run(ws, "strings -n 4 /data/binary.bin")

    print("\n━━━ tsort ━━━")
    await run(ws, "tsort /data/deps.txt")

    print("\n━━━ csplit (split on pattern) ━━━")
    await run(ws, "csplit /data/tsv.txt '/hello/'")
    await run(ws, "ls /data/")

    print("\n━━━ zip + unzip (roundtrip) ━━━")
    await run(ws, "zip /data/out.zip /data/sorted1.txt /data/sorted2.txt")
    await run(ws, "unzip -d /data/extracted /data/out.zip")
    await run(ws, "ls /data/extracted/")
    await run(ws, "ls /data/extracted/data/")
    await run(ws, "cat /data/extracted/data/sorted1.txt")

    print("\n━━━ zgrep (gzip then search) ━━━")
    await run(ws, "gzip /data/words.txt")
    await run(ws, "zgrep banana /data/words.txt.gz")

    print("\n━━━ patch (unified diff) ━━━")
    seed("/orig.txt", b"line1\nline2\nline3\n")
    seed(
        "/change.diff",
        b"--- /orig.txt\n+++ /orig.txt\n"
        b"@@ -1,3 +1,3 @@\n line1\n-line2\n+LINE2\n line3\n",
    )
    await run(ws, "patch -i /data/change.diff")
    await run(ws, "cat /data/orig.txt")


asyncio.run(main())
