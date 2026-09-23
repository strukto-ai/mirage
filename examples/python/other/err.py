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

from mirage import RAMVFS, MountMode, Workspace

ws = Workspace(
    {"/data/": RAMVFS()},
    mode=MountMode.WRITE,
)

ws.dispatch("mkdir", "/data/logs")
ws.dispatch("mkdir", "/data/src")
APP_LOG = (b"INFO  server started\nERROR disk full\n"
           b"INFO  request ok\nERROR timeout\n")
ws.dispatch("tee", "/data/logs/app.log", data=APP_LOG)
ws.dispatch("tee",
            "/data/src/main.py",
            data=b'def main():\n    print("hello")\n')
ws.dispatch("tee",
            "/data/src/utils.py",
            data=b"def add(a, b):\n    return a + b\n")
ws.dispatch("tee", "/data/notes.txt", data=b"line one\nline two\nline three\n")


async def log_result(label: str, io) -> None:
    stdout = (await io.stdout_str()).rstrip("\n")
    stderr = (await io.stderr_str()).rstrip("\n")
    code = io.exit_code
    print(f"\n{'─' * 60}")
    print(f"  $ {label}")
    print(f"  exit_code={code}")
    if stdout:
        for line in stdout.splitlines():
            print(f"  stdout │ {line}")
    if stderr:
        for line in stderr.splitlines():
            print(f"  stderr │ {line}")
    if not stdout and not stderr:
        print("  (no output)")


async def main():
    print("=" * 60)
    print(" Stderr Warnings & Error Handling Demo")
    print("=" * 60)

    # ── file not found ───────────────────────────────────────────────────
    io = await ws.shell("cat /data/nonexistent.txt")
    await log_result("cat /data/nonexistent.txt", io)

    # ── ls on missing directory ──────────────────────────────────────────
    io = await ws.shell("ls /data/missing/")
    await log_result("ls /data/missing/", io)

    # ── grep on missing file ─────────────────────────────────────────────
    io = await ws.shell("grep hello /data/ghost.txt")
    await log_result("grep hello /data/ghost.txt", io)

    # ── find on missing path ─────────────────────────────────────────────
    io = await ws.shell("find /data/nowhere")
    await log_result("find /data/nowhere", io)

    # ── recursive grep with -l (files only) on valid dir ─────────────────
    io = await ws.shell("grep -rl def /data/src")
    await log_result("grep -rl def /data/src", io)

    # ── pipe: error in first stage ───────────────────────────────────────
    io = await ws.shell("cat /data/nonexistent.txt | head -n 1")
    await log_result("cat /data/nonexistent.txt | head -n 1", io)

    # ── pipe: valid read, grep finds nothing ─────────────────────────────
    io = await ws.shell("cat /data/notes.txt | grep ZZZZZ")
    await log_result("cat /data/notes.txt | grep ZZZZZ", io)

    # ── && chain: first fails → second skipped ──────────────────────────
    io = await ws.shell(
        "cat /data/nonexistent.txt && echo 'this should not print'")
    await log_result("cat /data/nonexistent.txt && echo 'should not print'",
                     io)

    # ── || chain: first fails → fallback runs ────────────────────────────
    io = await ws.shell("cat /data/nonexistent.txt || echo 'fallback executed'"
                        )
    await log_result("cat /data/nonexistent.txt || echo 'fallback executed'",
                     io)

    # ── complex: (grep | sort) && echo ok || echo fail ───────────────────
    io = await ws.shell(
        "(grep ERROR /data/logs/app.log | sort) && echo ok || echo fail")
    await log_result(
        "(grep ERROR /data/logs/app.log | sort) && echo ok || echo fail", io)

    # ── complex: same but grep finds nothing → fail path ─────────────────
    io = await ws.shell(
        "(grep ZZZZZ /data/logs/app.log | sort) && echo ok || echo fail")
    await log_result(
        "(grep ZZZZZ /data/logs/app.log | sort) && echo ok || echo fail", io)

    # ── semicolon: independent commands, first fails ─────────────────────
    io = await ws.shell(
        "cat /data/nonexistent.txt ; cat /data/notes.txt | head -n 1")
    await log_result(
        "cat /data/nonexistent.txt ; cat /data/notes.txt | head -n 1", io)

    # ── rm missing file (no -f) vs rm -f ────────────────────────────────
    io = await ws.shell("rm /data/nonexistent.txt")
    await log_result("rm /data/nonexistent.txt", io)

    io = await ws.shell("rm -f /data/nonexistent.txt")
    await log_result("rm -f /data/nonexistent.txt", io)

    # ── diff with missing file ───────────────────────────────────────────
    io = await ws.shell("diff /data/notes.txt /data/nonexistent.txt")
    await log_result("diff /data/notes.txt /data/nonexistent.txt", io)

    # ── stat on missing file ─────────────────────────────────────────────
    io = await ws.shell("stat /data/nonexistent.txt")
    await log_result("stat /data/nonexistent.txt", io)

    # ── tree on missing dir ──────────────────────────────────────────────
    io = await ws.shell("tree /data/nowhere")
    await log_result("tree /data/nowhere", io)

    # ── multi-pipe success: grep | sort | head ───────────────────────────
    io = await ws.shell("grep ERROR /data/logs/app.log | sort | head -n 1")
    await log_result("grep ERROR /data/logs/app.log | sort | head -n 1", io)

    # ── execution history: exit codes per command ─────────────────────
    print(f"\n{'═' * 60}")
    print(" Execution History")
    print(f"{'═' * 60}")

    for entry in (await ws.history())[-6:]:
        print(f"\n  $ {entry['command']}")
        print(f"    exit={entry['exit_code']}")


asyncio.run(main())
