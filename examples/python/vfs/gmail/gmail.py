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
import json
import os
import shlex

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.commands.cli.builtin.gws import GWS
from mirage.types import PathSpec
from mirage.vfs.gmail import GmailConfig, GmailVFS

load_dotenv(".env.development")

config = GmailConfig(
    client_id=os.environ["GOOGLE_CLIENT_ID"],
    client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
    refresh_token=os.environ["GOOGLE_REFRESH_TOKEN"],
)
vfs = GmailVFS(config=config)


async def main() -> None:
    ws = Workspace({"/gmail": vfs}, mode=MountMode.WRITE)
    # The gws verbs are a CLI install, separate from the mounts.
    ws.register_cli("gws", GWS, config.model_dump())

    print("=== not-found errors show the full virtual path ===")
    for cmd in (
        "cat /gmail/__nf_missing__.txt",
        "head /gmail/__nf_missing__.txt",
        "stat /gmail/__nf_missing__.txt",
    ):
        result = await ws.shell(cmd)
        print(f"$ {cmd}")
        print(
            f"  exit={result.exit_code}  {(await result.stderr_str()).strip()}"
        )

    # ls root labels
    print("=== ls /gmail/ ===")
    result = await ws.shell("ls /gmail/")
    print(await result.stdout_str())

    # Pick INBOX
    labels = (await result.stdout_str()).strip().splitlines()
    label = "INBOX"
    if not any("INBOX" in lb for lb in labels):
        label = labels[0] if labels else ""
    if not label:
        print("No labels")
        return

    # ls label (date directories)
    print(f"=== ls /gmail/{label}/ ===")
    result = await ws.shell(f"ls {shlex.quote(f'/gmail/{label}/')}")
    print(await result.stdout_str())

    dates = (await result.stdout_str()).strip().splitlines()
    if not dates:
        print("No dates")
        return
    first_date = dates[0]

    # ls date dir (messages)
    print(f"=== ls /gmail/{label}/{first_date}/ ===")
    result = await ws.shell(
        f"ls {shlex.quote(f'/gmail/{label}/{first_date}/')}"
    )
    print(await result.stdout_str())

    messages = [
        m
        for m in (await result.stdout_str()).strip().splitlines()
        if m.endswith(".gmail.json")
    ]
    if not messages:
        print("No messages")
        return
    first_msg = messages[0]
    msg_path = f"/gmail/{label}/{first_date}/{first_msg}"

    # cat message
    print(f"=== cat {msg_path} ===")
    result = await ws.shell(f"cat {shlex.quote(msg_path)}")
    print((await result.stdout_str())[:500])

    # head
    print("=== head -n 5 ===")
    result = await ws.shell(f"head -n 5 {shlex.quote(msg_path)}")
    print(await result.stdout_str())

    # tail
    print("=== tail -n 3 ===")
    result = await ws.shell(f"tail -n 3 {shlex.quote(msg_path)}")
    print(await result.stdout_str())

    # wc
    print("=== wc -l ===")
    result = await ws.shell(f"wc -l {shlex.quote(msg_path)}")
    print(await result.stdout_str())

    # stat
    print("=== stat ===")
    result = await ws.shell(f"stat {shlex.quote(msg_path)}")
    print(await result.stdout_str())

    # chmod/chown/touch never hit the Gmail API: attrs land in the
    # workspace namespace (durable, snapshot-captured) and merge into
    # dispatch-level stat.
    print(f"=== metadata overlay on {msg_path} ===")
    result = await ws.shell(
        f"chmod 640 {shlex.quote(msg_path)} && chown 500:dev"
        f" {shlex.quote(msg_path)}"
        f" && touch -t 202601021530 {shlex.quote(msg_path)}"
    )
    print(f"  chmod/chown/touch exit={result.exit_code}")
    st, _ = await ws.dispatch("stat", PathSpec.from_str_path(msg_path))
    st_mode = oct(st.mode)[2:] if st.mode is not None else "-"
    print(
        f"  dispatch stat: mode={st_mode} uid={st.uid} "
        f"gid={st.gid} mtime={st.modified}"
    )

    # jq
    print("=== jq .subject ===")
    result = await ws.shell(f'jq ".subject" {shlex.quote(msg_path)}')
    print(await result.stdout_str())

    print("=== jq .from ===")
    result = await ws.shell(f'jq ".from" {shlex.quote(msg_path)}')
    print(await result.stdout_str())

    # nl
    print("=== nl ===")
    result = await ws.shell(f"nl {shlex.quote(msg_path)}")
    print((await result.stdout_str())[:300])

    # tree
    print("=== tree -L 1 /gmail/ ===")
    result = await ws.shell("tree -L 1 /gmail/")
    print(await result.stdout_str())

    print(f"=== tree -L 1 /gmail/{label}/ ===")
    result = await ws.shell(f"tree -L 1 {shlex.quote(f'/gmail/{label}/')}")
    print(await result.stdout_str())

    # find
    print("=== find -name '*.gmail.json' ===")
    result = await ws.shell(
        f"find {shlex.quote(f'/gmail/{label}/{first_date}/')}"
        ' -name "*.gmail.json" | head -n 5'
    )
    print(await result.stdout_str())

    # grep
    print("=== grep subject ===")
    result = await ws.shell(f"grep subject {shlex.quote(msg_path)}")
    print(await result.stdout_str())

    # rg
    print("=== rg subject ===")
    result = await ws.shell(f"rg subject {shlex.quote(msg_path)}")
    print(await result.stdout_str())

    # ── native search dispatch (Gmail q= API) ────────
    print(
        f"\n=== grep harbor /gmail/{label}/{first_date}/*.gmail.json"
        " (date scope) ==="
    )
    result = await ws.shell(
        f"grep harbor {shlex.quote(f'/gmail/{label}/{first_date}/')}"
        "*.gmail.json"
    )
    out = (await result.stdout_str()).strip()
    lines = out.splitlines() if out else []
    print(f"  exit={result.exit_code} matches: {len(lines)}")
    for line in lines[:3]:
        print(f"  {line[:150]}")

    print(f"\n=== grep harbor /gmail/{label}/ (label scope) ===")
    result = await ws.shell(f"grep harbor {shlex.quote(f'/gmail/{label}/')}")
    out = (await result.stdout_str()).strip()
    lines = out.splitlines() if out else []
    print(f"  exit={result.exit_code} matches: {len(lines)}")
    for line in lines[:3]:
        print(f"  {line[:150]}")

    print("\n=== grep harbor /gmail/ (mailbox scope) ===")
    result = await ws.shell("grep harbor /gmail/")
    out = (await result.stdout_str()).strip()
    lines = out.splitlines() if out else []
    print(f"  exit={result.exit_code} matches: {len(lines)}")
    for line in lines[:3]:
        print(f"  {line[:150]}")

    print("\n=== rg harbor /gmail/ ===")
    result = await ws.shell("rg harbor /gmail/")
    out = (await result.stdout_str()).strip()
    lines = out.splitlines() if out else []
    print(f"  exit={result.exit_code} matches: {len(lines)}")
    for line in lines[:3]:
        print(f"  {line[:150]}")

    # basename
    print("=== basename ===")
    result = await ws.shell(f"basename {shlex.quote(msg_path)}")
    print(await result.stdout_str())

    # dirname
    print("=== dirname ===")
    result = await ws.shell(f"dirname {shlex.quote(msg_path)}")
    print(await result.stdout_str())

    # realpath
    print("=== realpath ===")
    result = await ws.shell(f"realpath {shlex.quote(msg_path)}")
    print(await result.stdout_str())

    # VFS-specific commands

    # gws gmail triage
    print("=== gws gmail triage ===")
    result = await ws.shell('gws gmail triage --query "is:unread" --max 3')
    print((await result.stdout_str())[:500])

    # ── glob expansion (exercises resolve_glob → readdir)
    print("=== echo glob: *.gmail.json ===")
    result = await ws.shell(
        f"echo {shlex.quote(f'/gmail/{label}/{first_date}/')}*.gmail.json"
    )
    out = (await result.stdout_str()).strip()
    print(f"  {out[:200]}")
    assert out, "glob should match at least one file"

    print("=== for f in *.gmail.json (glob loop) ===")
    result = await ws.shell(
        f"for f in {shlex.quote(f'/gmail/{label}/{first_date}/')}"
        "*.gmail.json;"
        " do echo found:$f; done | head -n 3"
    )
    out = (await result.stdout_str()).strip()
    for line in out.splitlines():
        print(f"  {line[:120]}")

    # gws gmail read (use message_id from filename)
    msg_id = first_msg.rsplit("__", 1)[-1].replace(".gmail.json", "")
    print(f"=== gws gmail read --id {msg_id} ===")
    result = await ws.shell(f"gws gmail read --id {shlex.quote(msg_id)}")
    print((await result.stdout_str())[:500])

    # gws gmail send
    print("=== gws gmail send ===")
    result = await ws.shell(
        'gws gmail send --to "zechengzhang97@gmail.com"'
        ' --subject "Test from MIRAGE"'
        ' --body "Sent by gmail.py example"'
    )
    out = await result.stdout_str()
    print(out[:200])

    sent_id = ""
    if out.strip():
        sent = json.loads(out)
        sent_id = sent.get("id", "")

    # gws gmail reply
    if sent_id:
        print("=== gws gmail reply ===")
        result = await ws.shell(
            f"gws gmail reply --message-id {shlex.quote(sent_id)}"
            ' --body "Reply from MIRAGE"'
        )
        print((await result.stdout_str())[:200])

    # gws gmail reply-all
    if sent_id:
        print("=== gws gmail reply-all ===")
        result = await ws.shell(
            f"gws gmail reply-all --message-id {shlex.quote(sent_id)}"
            ' --body "Reply-all from MIRAGE"'
        )
        print((await result.stdout_str())[:200])

    # gws gmail forward
    if sent_id:
        print("=== gws gmail forward ===")
        result = await ws.shell(
            f"gws gmail forward --message-id {shlex.quote(sent_id)}"
            ' --to "zechengzhang97@gmail.com"'
        )
        print((await result.stdout_str())[:200])
    await ws.close()


if __name__ == "__main__":
    asyncio.run(main())
