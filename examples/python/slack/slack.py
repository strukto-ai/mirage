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
from mirage.resource.slack import SlackConfig, SlackResource
from mirage.types import PathSpec

load_dotenv(".env.development")

config = SlackConfig(
    token=os.environ["SLACK_BOT_TOKEN"],
    search_token=os.environ.get("SLACK_USER_TOKEN"),
)
resource = SlackResource(config=config)


async def main():
    ws = Workspace({"/slack": resource}, mode=MountMode.READ)

    print("=== not-found errors show the full virtual path ===")
    for cmd in ("cat /slack/__nf_missing__.txt",
                "head /slack/__nf_missing__.txt",
                "stat /slack/__nf_missing__.txt"):
        result = await ws.execute(cmd)
        print(f"$ {cmd}")
        print(f"  exit={result.exit_code}  "
              f"{(await result.stderr_str()).strip()}")

    # ── discover structure ────────────────────────────
    print("=== ls /slack/ (root) ===")
    r = await ws.execute("ls /slack/")
    print(await r.stdout_str())

    print("=== ls /slack/channels/ ===")
    r = await ws.execute("ls /slack/channels/ | head -n 5")
    print(await r.stdout_str())

    print("=== ls -l /slack/channels/ (mtime from created) ===")
    r = await ws.execute("ls -l /slack/channels/ | head -n 5")
    print(await r.stdout_str())

    print("=== ls /slack/users/ ===")
    r = await ws.execute("ls /slack/users/ | head -n 5")
    print(await r.stdout_str())

    # Pick first channel
    r = await ws.execute("ls /slack/channels/ | head -n 1")
    first_ch = (await r.stdout_str()).strip()
    if not first_ch:
        print("no channels found")
        return

    base = f"/slack/channels/{first_ch}"

    print(f"=== ls {first_ch} (dates) ===")
    r = await ws.execute(f'ls "{base}/" | tail -n 5')
    print(await r.stdout_str())

    # Pick the most recent date directory and target its chat.jsonl.
    r = await ws.execute(f'ls "{base}/" | tail -n 1')
    date_dir = (await r.stdout_str()).strip()
    if not date_dir:
        print("  no dates found")
        return
    date_path = f"{base}/{date_dir.rsplit('/', 1)[-1]}"
    file_path = f"{date_path}/chat.jsonl"
    target = "chat.jsonl"

    print(f"  using date: {date_path}")
    print(f"  using file: {target}")

    # ── ls inside date dir (chat.jsonl + files/) ─────
    print(f"\n=== ls {date_path}/ ===")
    r = await ws.execute(f'ls "{date_path}/"')
    print((await r.stdout_str()).rstrip())

    # ── cat ──────────────────────────────────────────
    print(f"\n=== cat {target} | head -n 3 ===")
    r = await ws.execute(f'cat "{file_path}" | head -n 3')
    print((await r.stdout_str())[:300])

    # ── cat user profile ─────────────────────────────
    r = await ws.execute("ls /slack/users/ | head -n 1")
    first_user = (await r.stdout_str()).strip()
    print(f"\n=== cat /slack/users/{first_user} ===")
    r = await ws.execute(f'cat "/slack/users/{first_user}"')
    out = (await r.stdout_str()).strip()
    if out:
        print(f"  {out[:200]}")
    else:
        print("  (empty)")
    if (await r.stderr_str()):
        print(f"  stderr: {await r.stderr_str()}")

    # ── stat ─────────────────────────────────────────
    print(f"\n=== stat {target} ===")
    r = await ws.execute(f'stat "{file_path}"')
    print(f"  {(await r.stdout_str()).strip()}")

    # ── wc ───────────────────────────────────────────
    print(f"\n=== wc -l {target} ===")
    r = await ws.execute(f'wc -l "{file_path}"')
    print(f"  {(await r.stdout_str()).strip()}")

    # ── head ─────────────────────────────────────────
    print(f"\n=== head -n 2 {target} ===")
    r = await ws.execute(f'head -n 2 "{file_path}"')
    out = (await r.stdout_str()).strip()
    if out:
        for line in out.splitlines():
            print(f"  {line[:120]}")

    # ── tail ─────────────────────────────────────────
    print(f"\n=== tail -n 1 {target} ===")
    r = await ws.execute(f'tail -n 1 "{file_path}"')
    out = (await r.stdout_str()).strip()
    if out:
        print(f"  {out[:120]}")

    # ── metadata (namespace overlay) ─────────────────
    # chmod/chown/touch never hit the Slack API: attrs land in the
    # workspace namespace (durable, snapshot-captured) and merge into
    # dispatch-level stat.
    print(f"\n=== metadata overlay on {target} ===")
    r = await ws.execute(f'chmod 640 "{file_path}" && chown 500:dev'
                         f' "{file_path}" && touch -t 202601021530'
                         f' "{file_path}"')
    print(f"  chmod/chown/touch exit={r.exit_code}")
    st, _ = await ws.dispatch("stat", PathSpec.from_str_path(file_path))
    print(f"  dispatch stat: mode={oct(st.mode)[2:]} uid={st.uid} "
          f"gid={st.gid} mtime={st.modified}")

    # ── basename / dirname / realpath (path ops) ─────
    print(f"\n=== basename {file_path} ===")
    r = await ws.execute(f'basename "{file_path}"')
    out = (await r.stdout_str()).strip()
    print(f"  {out}")
    assert out == target, f"basename expected {target!r}, got {out!r}"

    print(f"\n=== dirname {file_path} ===")
    r = await ws.execute(f'dirname "{file_path}"')
    out = (await r.stdout_str()).strip()
    print(f"  {out}")
    assert out == date_path, f"dirname expected {date_path!r}, got {out!r}"

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

    # ── grep at FILE level ───────────────────────────
    print(f"\n=== grep message {target} ===")
    r = await ws.execute(f'grep message "{file_path}"')
    lines = (await r.stdout_str()).strip().splitlines() if (
        await r.stdout_str()).strip() else []
    print(f"  matches: {len(lines)}")
    if lines:
        print(f"  first: {lines[0][:120]}...")

    print(f"\n=== grep -c message {target} ===")
    r = await ws.execute(f'grep -c message "{file_path}"')
    print(f"  count: {(await r.stdout_str()).strip()}")

    # ── rg (directory scan) ──────────────────────────
    print(f"\n=== rg message {base}/ ===")
    r = await ws.execute(f'rg message "{base}/"')
    lines = (await r.stdout_str()).strip().splitlines() if (
        await r.stdout_str()).strip() else []
    print(f"  matches across dates: {len(lines)}")

    print(f"\n=== rg -l message {base}/ ===")
    r = await ws.execute(f'rg -l message "{base}/"')
    files = (await r.stdout_str()).strip().splitlines() if (
        await r.stdout_str()).strip() else []
    print(f"  files with matches: {len(files)}")
    for f in files:
        print(f"  {f}")

    # ── attachments: ls, stat, rg on files/ ──────────
    files_dir = f"{date_path}/files"
    print(f"\n=== ls {files_dir}/ (attachments) ===")
    r = await ws.execute(f'ls "{files_dir}/"')
    blob_lines = (await r.stdout_str()).strip().splitlines()
    for line in blob_lines:
        print(f"  {line}")

    if blob_lines:
        first_blob = blob_lines[0].rsplit("/", 1)[-1]
        blob_path = f"{files_dir}/{first_blob}"
        print(f"\n=== stat {first_blob} ===")
        r = await ws.execute(f'stat "{blob_path}"')
        print(f"  {(await r.stdout_str()).strip()}")

        # search.files push-down — works on text-bearing blobs
        # (PDFs, code, docs) without downloading bytes.
        print(f"\n=== rg . {files_dir}/ (search.files push-down) ===")
        r = await ws.execute(f'rg . "{files_dir}/"')
        for line in (await r.stdout_str()).strip().splitlines()[:5]:
            print(f"  {line[:150]}")

    # ── native search dispatch (search.messages requires user token) ──
    # Note: Slack's search.messages API requires a user token (xoxp-)
    # with search:read scope. Bot tokens (xoxb-) get not_allowed_token_type.
    for label, cmd in [
        (f"grep hello {date_path}/chat.jsonl (date scope)",
         f'grep hello "{date_path}/chat.jsonl"'),
        (f"grep hello {base}/ (channel scope)", f'grep hello "{base}/"'),
        ("grep hello /slack/channels/ (workspace scope)",
         'grep hello /slack/channels/'),
        ("rg hello /slack/ (workspace scope)", 'rg hello /slack/'),
    ]:
        print(f"\n=== {label} ===")
        r = await ws.execute(cmd)
        out = (await r.stdout_str()).strip()
        err = (await r.stderr_str()).strip()
        lines = out.splitlines() if out else []
        print(f"  exit={r.exit_code} matches: {len(lines)}")
        if err:
            print(f"  stderr: {err[:200]}")
        for line in lines[:3]:
            print(f"  {line[:150]}")

    # ── jq ───────────────────────────────────────────
    print(f"\n=== jq '.[] | .user' {target} ===")
    r = await ws.execute(f'jq ".[] | .user" "{file_path}"')
    print(f"  exit={r.exit_code}")
    out = (await r.stdout_str()).strip()
    if out:
        for line in out.splitlines()[:5]:
            print(f"  {line}")

    print(f"\n=== cat {target} | jq -r '.[] | .text' | head -n 5 ===")
    r = await ws.execute(f'cat "{file_path}" | jq -r ".[] | .text" | head -n 5'
                         )
    print(f"  exit={r.exit_code}")
    out = (await r.stdout_str()).strip()
    if out:
        for line in out.splitlines()[:5]:
            print(f"  {line}")

    # ── tree ─────────────────────────────────────────
    print("\n=== tree -L 1 /slack/ ===")
    r = await ws.execute('tree -L 1 /slack/')
    print(f"  exit={r.exit_code}")
    out = (await r.stdout_str()).strip()
    if out:
        for line in out.splitlines():
            print(f"  {line}")

    # ── find ─────────────────────────────────────────
    print(f"\n=== find {base}/ -name 'chat.jsonl' | tail -n 5 ===")
    r = await ws.execute(f'find "{base}/" -name "chat.jsonl" | tail -n 5')
    print(f"  exit={r.exit_code}")
    out = (await r.stdout_str()).strip()
    if out:
        for line in out.splitlines():
            print(f"  {line}")

    print("\n=== find /slack/ -name 'general*' ===")
    r = await ws.execute('find /slack/ -name "general*"')
    print(f"  exit={r.exit_code}")
    out = (await r.stdout_str()).strip()
    if out:
        for line in out.splitlines():
            print(f"  {line}")

    # -path matches the display path; -size counts dirs and sizeless
    # rendered files as 0 (so +0c drops them, -1k keeps them).
    print(f"\n=== find {base}/ -path '*general*' | tail -n 5 ===")
    r = await ws.execute(f'find "{base}/" -path "*general*" | tail -n 5')
    print(f"  exit={r.exit_code}")
    out = (await r.stdout_str()).strip()
    if out:
        for line in out.splitlines():
            print(f"  {line}")

    print(f"\n=== find {base}/ -maxdepth 1 -size +0c ===")
    r = await ws.execute(f'find "{base}/" -maxdepth 1 -size +0c')
    print(f"  exit={r.exit_code} (dirs count as size 0, expect no output)")

    print(f"\n=== find {base}/ -maxdepth 1 -size -1k | tail -n 3 ===")
    r = await ws.execute(f'find "{base}/" -maxdepth 1 -size -1k | tail -n 3')
    print(f"  exit={r.exit_code}")
    out = (await r.stdout_str()).strip()
    if out:
        for line in out.splitlines():
            print(f"  {line}")

    # ── pwd / cd ─────────────────────────────────────
    print("\n=== pwd ===")
    r = await ws.execute("pwd")
    print(f"  {(await r.stdout_str()).strip()}")

    print(f'\n=== cd "{base}" ===')
    r = await ws.execute(f'cd "{base}"')
    print(f"  exit={r.exit_code}")

    print("\n=== pwd (after cd) ===")
    r = await ws.execute("pwd")
    print(f"  {(await r.stdout_str()).strip()}")

    # ── ls (no args) after cd — regression: bug where mount prefix
    # was dropped, so readdir returned []. Now hard-asserts that ls
    # surfaces cwd entries.
    print("\n=== ls (no args, in channel dir) ===")
    r = await ws.execute("ls | tail -n 5")
    out = (await r.stdout_str()).strip()
    assert out, "regression: `ls` (no args) after cd returned empty"
    for line in out.splitlines():
        print(f"  {line}")

    rel_chat = f"{date_dir.rsplit('/', 1)[-1]}/chat.jsonl"
    print(f"\n=== cat {rel_chat} (relative) | head -n 1 ===")
    r = await ws.execute(f'cat "{rel_chat}" | head -n 1')
    out = (await r.stdout_str()).strip()
    assert out, "regression: relative `cat` after cd returned empty"
    print(f"  {out[:120]}")

    # ── workspace-wide find — regression: would abort with
    # `not_in_channel` if any channel was inaccessible. Now skips
    # those channels and walks the rest.
    print("\n=== find /slack/ -name 'chat.jsonl' (must not abort) ===")
    r = await ws.execute('find /slack/ -name "chat.jsonl" | wc -l')
    count = int((await r.stdout_str()).strip() or "0")
    print(f"  matches: {count}")
    assert r.exit_code == 0, ("regression: workspace-wide find aborted; "
                              f"stderr={await r.stderr_str()}")
    assert count > 0, "regression: workspace-wide find returned no matches"

    # ── glob expansion: mid-path segments walk like bash, so
    # channels/*/<date>/chat.jsonl lists channels once, then each
    # channel's dates, keeping only channels that have that day.
    date_seg = date_path.rsplit("/", 1)[-1]
    print(f"\n=== echo /slack/channels/*/{date_seg}/chat.jsonl ===")
    r = await ws.execute(f"echo /slack/channels/*/{date_seg}/chat.jsonl")
    out = (await r.stdout_str()).strip()
    print(f"  {out[:200]}")
    assert "/chat.jsonl" in out, "mid-path glob did not expand"

    print(f"\n=== for f in {base}/* (date glob loop) ===")
    r = await ws.execute(
        f'for f in "{base}/"*; do echo found:$f; done | head -n 3')
    out = (await r.stdout_str()).strip()
    for line in out.splitlines():
        print(f"  {line[:120]}")

    # A glob that matches nothing stays the literal word (bash with
    # nullglob off), so the command reports it like GNU coreutils.
    print("\n=== cat /slack/channels/zz-none-*/chat.jsonl (no match) ===")
    r = await ws.execute("cat /slack/channels/zz-none-*/chat.jsonl")
    err = (await r.stderr_str()).strip()
    print(f"  exit={r.exit_code}  {err[:120]}")
    assert r.exit_code == 1 and "zz-none-*" in err


if __name__ == "__main__":
    asyncio.run(main())
