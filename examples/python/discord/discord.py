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
import re

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.resource.discord import DiscordConfig, DiscordResource
from mirage.types import PathSpec

load_dotenv(".env.development")

config = DiscordConfig(token=os.environ["DISCORD_BOT_TOKEN"])
resource = DiscordResource(config=config)


def _assert_nonempty(text: str, msg: str) -> None:
    if not text.strip():
        raise AssertionError(f"regression: {msg}")


async def main():
    ws = Workspace({"/discord": resource}, mode=MountMode.READ)

    print("=== not-found errors show the full virtual path ===")
    for cmd in ("cat /discord/__nf_missing__.txt",
                "head /discord/__nf_missing__.txt",
                "stat /discord/__nf_missing__.txt"):
        result = await ws.execute(cmd)
        print(f"$ {cmd}")
        print(f"  exit={result.exit_code}  "
              f"{(await result.stderr_str()).strip()}")

    # ── discover structure ────────────────────────────
    print("=== ls /discord/ (guilds) ===")
    r = await ws.execute("ls /discord/")
    print(await r.stdout_str())
    _assert_nonempty(await r.stdout_str(), "ls /discord/ returned no guilds")

    guilds = (await r.stdout_str()).strip().split("\n")
    guild = guilds[0].strip()
    print(f"=== ls /discord/{guild}/channels/ ===")
    r = await ws.execute(f'ls "/discord/{guild}/channels/"')
    print(await r.stdout_str())
    _assert_nonempty(await r.stdout_str(), "no channels in first guild")

    print(f"=== ls -l /discord/{guild}/channels/ "
          "(mtime from last_message_id) ===")
    long_ch = await ws.execute(
        f'ls -l "/discord/{guild}/channels/" | head -n 5')
    print(await long_ch.stdout_str())

    channels = (await r.stdout_str()).strip().splitlines()
    ch = channels[0].strip()
    base = f"/discord/{guild}/channels/{ch}"

    # ── pick the most recent date that has messages ────
    print(f"\n=== ls {base}/ (date directories) ===")
    r = await ws.execute(f'ls "{base}/" | tail -n 5')
    print(await r.stdout_str())
    dates = (await r.stdout_str()).strip().splitlines()
    if not dates:
        print("  (no date directories — channel is empty)")
        return
    # Walk newest → oldest, find one with non-empty chat.jsonl
    target_date: str | None = None
    for d in reversed(dates):
        d = d.strip()
        r = await ws.execute(f'cat "{base}/{d}/chat.jsonl" | head -c 1')
        if (await r.stdout_str()).strip():
            target_date = d
            break
    if target_date is None:
        target_date = dates[-1].strip()
    print(f"  using date: {target_date}")
    file_path = f"{base}/{target_date}/chat.jsonl"

    # ── cat the chat.jsonl ────────────────────────────
    print(f"\n=== cat {target_date}/chat.jsonl | head -n 3 ===")
    r = await ws.execute(f'cat "{file_path}" | head -n 3')
    print((await r.stdout_str())[:300])

    # ── list date contents (chat.jsonl + files dir) ────
    print(f"\n=== ls {base}/{target_date}/ ===")
    r = await ws.execute(f'ls "{base}/{target_date}/"')
    print(await r.stdout_str())

    # chmod/chown/touch never hit the Discord API: attrs land in the
    # workspace namespace (durable, snapshot-captured) and merge into
    # dispatch-level stat.
    print(f"=== metadata overlay on {file_path} ===")
    meta_res = await ws.execute(f'chmod 640 "{file_path}"'
                                f' && chown 500:dev "{file_path}"'
                                f' && touch -t 202601021530 "{file_path}"')
    print(f"  chmod/chown/touch exit={meta_res.exit_code}")
    meta_st, _ = await ws.dispatch("stat",
                                   PathSpec.from_str_path(f"{file_path}"))
    print(f"  dispatch stat: mode={oct(meta_st.mode)[2:]} uid={meta_st.uid} "
          f"gid={meta_st.gid} mtime={meta_st.modified}")

    # ── list attachments for that date (may be empty) ─
    print(f"\n=== ls {base}/{target_date}/files/ (attachments) ===")
    r = await ws.execute(f'ls "{base}/{target_date}/files/"')
    files_out = (await r.stdout_str()).strip()
    if files_out:
        for line in files_out.splitlines()[:5]:
            print(f"  {line}")
    else:
        print("  (no attachments on this date)")

    # ── stat + cat first attachment (byte-exact CDN download) ──
    if files_out:
        first_att = files_out.splitlines()[0].strip()
        att_path = f"{base}/{target_date}/files/{first_att}"

        print(f"\n=== stat {first_att} ===")
        r = await ws.execute(f'stat "{att_path}"')
        stat_out = (await r.stdout_str()).strip()
        print(f"  {stat_out[:200]}")
        size_match = re.search(r"size=(\d+)", stat_out)
        expected_size = int(size_match.group(1)) if size_match else None

        print(f"\n=== cat {first_att} (byte-exact CDN download) ===")
        r = await ws.execute(f'cat "{att_path}"')
        data = await r.materialize_stdout()
        print(f"  bytes={len(data)} expected={expected_size} "
              f"exit={r.exit_code}")
        if expected_size is not None and len(data) != expected_size:
            raise AssertionError(
                f"regression: attachment cat got {len(data)} bytes, "
                f"expected {expected_size}")

    # ── grep at FILE level ────────────────────────────
    print(f"\n=== grep at FILE level: grep . {target_date}/chat.jsonl ===")
    r = await ws.execute(f'grep -c . "{file_path}"')
    print(f"  line count: {(await r.stdout_str()).strip()}")

    # ── grep at CHANNEL level (Discord search push-down) ──
    print(f"\n=== grep at CHANNEL level: grep . {base}/ ===")
    r = await ws.execute(f'grep -m 5 . "{base}/"')
    print(f"  exit={r.exit_code}")
    out = (await r.stdout_str()).strip()
    if out:
        for line in out.splitlines()[:5]:
            print(f"  {line[:120]}")
    else:
        print("  (no results)")
    err = await r.stderr_str()
    if err:
        print(f"  stderr: {err[:200]}")

    # ── grep at GUILD level ──────────────────────────
    print(f"\n=== grep at GUILD level: grep . /discord/{guild}/ ===")
    r = await ws.execute(f'grep -m 5 . "/discord/{guild}/"')
    print(f"  exit={r.exit_code}")
    out = (await r.stdout_str()).strip()
    if out:
        for line in out.splitlines()[:5]:
            print(f"  {line[:120]}")
    else:
        print("  (no results)")

    # ── jq pipeline ──────────────────────────────────
    print(f"\n=== jq '.[] | .author.username' {target_date}/chat.jsonl ===")
    r = await ws.execute(f'jq -r ".[] | .author.username" "{file_path}"'
                         ' | head -n 5')
    out = (await r.stdout_str()).strip()
    if out:
        for line in out.splitlines()[:5]:
            print(f"  {line}")

    # ── stat ─────────────────────────────────────────
    print(f"\n=== stat {file_path} ===")
    r = await ws.execute(f'stat "{file_path}"')
    print(f"  {(await r.stdout_str()).strip()[:200]}")

    # ── wc / head / tail ─────────────────────────────
    print(f"\n=== wc -l {target_date}/chat.jsonl ===")
    r = await ws.execute(f'wc -l "{file_path}"')
    print(f"  {(await r.stdout_str()).strip()}")

    # ── basename / dirname / realpath (path ops) ─────
    print(f"\n=== basename {file_path} ===")
    r = await ws.execute(f'basename "{file_path}"')
    out = (await r.stdout_str()).strip()
    print(f"  {out}")
    assert out == "chat.jsonl", f"basename expected 'chat.jsonl', got {out!r}"

    expected_dir = f"{base}/{target_date}"
    print(f"\n=== dirname {file_path} ===")
    r = await ws.execute(f'dirname "{file_path}"')
    out = (await r.stdout_str()).strip()
    print(f"  {out}")
    assert out == expected_dir, (
        f"dirname expected {expected_dir!r}, got {out!r}")

    print(f"\n=== realpath {file_path} ===")
    r = await ws.execute(f'realpath "{file_path}"')
    out = (await r.stdout_str()).strip()
    print(f"  {out}")
    assert out == file_path, f"realpath expected {file_path!r}, got {out!r}"

    print(f"\n=== realpath -e {file_path} (must exist) ===")
    r = await ws.execute(f'realpath -e "{file_path}"')
    print(f"  exit={r.exit_code} {(await r.stdout_str()).strip()}")
    assert r.exit_code == 0, (
        "regression: realpath -e failed for existing file; "
        f"stderr={await r.stderr_str()}")

    # ── tree ─────────────────────────────────────────
    print(f"\n=== tree -L 2 /discord/{guild}/ ===")
    r = await ws.execute(f'tree -L 2 "/discord/{guild}/" | head -n 20')
    out = (await r.stdout_str()).strip()
    for line in out.splitlines()[:20]:
        print(f"  {line}")

    # ── find chat.jsonl everywhere ───────────────────
    print(f"\n=== find /discord/{guild}/ -name chat.jsonl | head -n 5 ===")
    r = await ws.execute(f'find "/discord/{guild}/" -name "chat.jsonl"'
                         ' | head -n 5')
    print(f"  exit={r.exit_code}")
    out = (await r.stdout_str()).strip()
    if out:
        for line in out.splitlines():
            print(f"  {line}")
    if r.exit_code != 0:
        raise AssertionError(
            f"regression: find chat.jsonl exited {r.exit_code} "
            "(soft errors should not abort)")

    # -path matches the display path; -size counts dirs and sizeless
    # rendered files as 0 (so +0c drops them, -1k keeps them).
    print(f"\n=== find /discord/{guild}/ -path '*channels*' | head -n 5 ===")
    r = await ws.execute(f'find "/discord/{guild}/" -path "*channels*"'
                         ' | head -n 5')
    print(f"  exit={r.exit_code}")
    out = (await r.stdout_str()).strip()
    if out:
        for line in out.splitlines():
            print(f"  {line}")
    if r.exit_code != 0 or not out:
        raise AssertionError("regression: find -path returned nothing")

    print(f"\n=== find /discord/{guild}/ -maxdepth 1 -size +0c ===")
    r = await ws.execute(f'find "/discord/{guild}/" -maxdepth 1 -size +0c')
    print(f"  exit={r.exit_code} (dirs count as size 0, expect no output)")
    if (await r.stdout_str()).strip():
        raise AssertionError("regression: -size +0c matched a directory")

    # ── pwd / cd / relative ──────────────────────────
    print(f"\n=== cd {base} ===")
    r = await ws.execute(f'cd "{base}"')
    print(f"  exit={r.exit_code}")

    print("\n=== pwd (after cd) ===")
    r = await ws.execute("pwd")
    print(f"  {(await r.stdout_str()).strip()}")

    print(f"\n=== cat {target_date}/chat.jsonl (relative) | head -n 1 ===")
    r = await ws.execute(f'cat "{target_date}/chat.jsonl" | head -n 1')
    out = (await r.stdout_str()).strip()
    if out:
        print(f"  {out[:120]}")

    # ── members ──────────────────────────────────────
    print(f"\n=== ls /discord/{guild}/members/ | head -n 5 ===")
    r = await ws.execute(f'ls "/discord/{guild}/members/" | head -n 5')
    mem_out = (await r.stdout_str()).strip()
    if mem_out:
        for line in mem_out.splitlines():
            print(f"  {line}")
        first_member = mem_out.splitlines()[0].strip()
        print(f"\n=== cat /discord/{guild}/members/{first_member} ===")
        r = await ws.execute(f'cat "/discord/{guild}/members/{first_member}"')
        body = (await r.stdout_str()).strip()
        print(f"  {body[:200]}")
    else:
        print("  (no members visible)")

    # ── glob expansion: a mid-path glob replaces the guild segment
    # (which may contain spaces) and walks into the literal tail.
    print("\n=== echo /discord/*/channels (mid-path glob) ===")
    r = await ws.execute("echo /discord/*/channels")
    out = (await r.stdout_str()).strip()
    print(f"  {out[:200]}")
    assert out.endswith("/channels"), "mid-path glob did not expand"

    print("\n=== for f in /discord/*/channels/* (channel glob loop) ===")
    r = await ws.execute(
        "for f in /discord/*/channels/*; do echo found:$f; done | head -n 3")
    out = (await r.stdout_str()).strip()
    for line in out.splitlines():
        print(f"  {line[:120]}")

    # A glob that matches nothing stays the literal word, so the
    # command reports it like GNU coreutils.
    print("\n=== cat /discord/zz-none-*/guild.json (no match) ===")
    r = await ws.execute("cat /discord/zz-none-*/guild.json")
    err = (await r.stderr_str()).strip()
    print(f"  exit={r.exit_code}  {err[:120]}")
    assert r.exit_code == 1 and "zz-none-*" in err


if __name__ == "__main__":
    asyncio.run(main())
