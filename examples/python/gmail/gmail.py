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

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.resource.gmail import GmailConfig, GmailResource
from mirage.types import PathSpec

load_dotenv(".env.development")

config = GmailConfig(
    client_id=os.environ["GOOGLE_CLIENT_ID"],
    client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
    refresh_token=os.environ["GOOGLE_REFRESH_TOKEN"],
)
resource = GmailResource(config=config)


async def main() -> None:
    ws = Workspace({"/gmail": resource}, mode=MountMode.WRITE)

    print("=== not-found errors show the full virtual path ===")
    for cmd in ("cat /gmail/__nf_missing__.txt",
                "head /gmail/__nf_missing__.txt",
                "stat /gmail/__nf_missing__.txt"):
        result = await ws.execute(cmd)
        print(f"$ {cmd}")
        print(f"  exit={result.exit_code}  "
              f"{(await result.stderr_str()).strip()}")

    # ls root labels
    print("=== ls /gmail/ ===")
    result = await ws.execute("ls /gmail/")
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
    result = await ws.execute(f"ls /gmail/{label}/")
    print(await result.stdout_str())

    dates = (await result.stdout_str()).strip().splitlines()
    if not dates:
        print("No dates")
        return
    first_date = dates[0]

    # ls date dir (messages)
    print(f"=== ls /gmail/{label}/{first_date}/ ===")
    result = await ws.execute(f"ls /gmail/{label}/{first_date}/")
    print(await result.stdout_str())

    messages = [
        m for m in (await result.stdout_str()).strip().splitlines()
        if m.endswith(".gmail.json")
    ]
    if not messages:
        print("No messages")
        return
    first_msg = messages[0]
    msg_path = f"/gmail/{label}/{first_date}/{first_msg}"

    # cat message
    print(f"=== cat {msg_path} ===")
    result = await ws.execute(f"cat {msg_path}")
    print((await result.stdout_str())[:500])

    # head
    print("=== head -n 5 ===")
    result = await ws.execute(f"head -n 5 {msg_path}")
    print(await result.stdout_str())

    # tail
    print("=== tail -n 3 ===")
    result = await ws.execute(f"tail -n 3 {msg_path}")
    print(await result.stdout_str())

    # wc
    print("=== wc -l ===")
    result = await ws.execute(f"wc -l {msg_path}")
    print(await result.stdout_str())

    # stat
    print("=== stat ===")
    result = await ws.execute(f"stat {msg_path}")
    print(await result.stdout_str())

    # chmod/chown/touch never hit the Gmail API: attrs land in the
    # workspace namespace (durable, snapshot-captured) and merge into
    # dispatch-level stat.
    print(f"=== metadata overlay on {msg_path} ===")
    result = await ws.execute(f'chmod 640 "{msg_path}" && chown 500:dev'
                              f' "{msg_path}"'
                              f' && touch -t 202601021530 "{msg_path}"')
    print(f"  chmod/chown/touch exit={result.exit_code}")
    st, _ = await ws.dispatch("stat", PathSpec.from_str_path(msg_path))
    print(f"  dispatch stat: mode={oct(st.mode)[2:]} uid={st.uid} "
          f"gid={st.gid} mtime={st.modified}")

    # jq
    print("=== jq .subject ===")
    result = await ws.execute(f'jq ".subject" {msg_path}')
    print(await result.stdout_str())

    print("=== jq .from ===")
    result = await ws.execute(f'jq ".from" {msg_path}')
    print(await result.stdout_str())

    # nl
    print("=== nl ===")
    result = await ws.execute(f"nl {msg_path}")
    print((await result.stdout_str())[:300])

    # tree
    print("=== tree -L 1 /gmail/ ===")
    result = await ws.execute("tree -L 1 /gmail/")
    print(await result.stdout_str())

    print(f"=== tree -L 1 /gmail/{label}/ ===")
    result = await ws.execute(f"tree -L 1 /gmail/{label}/")
    print(await result.stdout_str())

    # find
    print("=== find -name '*.gmail.json' ===")
    result = await ws.execute(
        f'find /gmail/{label}/{first_date}/ -name "*.gmail.json" | head -n 5')
    print(await result.stdout_str())

    # grep
    print("=== grep subject ===")
    result = await ws.execute(f"grep subject {msg_path}")
    print(await result.stdout_str())

    # rg
    print("=== rg subject ===")
    result = await ws.execute(f"rg subject {msg_path}")
    print(await result.stdout_str())

    # ── native search dispatch (Gmail q= API) ────────
    print(f"\n=== grep harbor /gmail/{label}/{first_date}/*.gmail.json"
          " (date scope) ===")
    result = await ws.execute(
        f'grep harbor /gmail/{label}/{first_date}/*.gmail.json')
    out = (await result.stdout_str()).strip()
    lines = out.splitlines() if out else []
    print(f"  exit={result.exit_code} matches: {len(lines)}")
    for line in lines[:3]:
        print(f"  {line[:150]}")

    print(f"\n=== grep harbor /gmail/{label}/ (label scope) ===")
    result = await ws.execute(f'grep harbor /gmail/{label}/')
    out = (await result.stdout_str()).strip()
    lines = out.splitlines() if out else []
    print(f"  exit={result.exit_code} matches: {len(lines)}")
    for line in lines[:3]:
        print(f"  {line[:150]}")

    print("\n=== grep harbor /gmail/ (mailbox scope) ===")
    result = await ws.execute('grep harbor /gmail/')
    out = (await result.stdout_str()).strip()
    lines = out.splitlines() if out else []
    print(f"  exit={result.exit_code} matches: {len(lines)}")
    for line in lines[:3]:
        print(f"  {line[:150]}")

    print("\n=== rg harbor /gmail/ ===")
    result = await ws.execute('rg harbor /gmail/')
    out = (await result.stdout_str()).strip()
    lines = out.splitlines() if out else []
    print(f"  exit={result.exit_code} matches: {len(lines)}")
    for line in lines[:3]:
        print(f"  {line[:150]}")

    # basename
    print("=== basename ===")
    result = await ws.execute(f"basename {msg_path}")
    print(await result.stdout_str())

    # dirname
    print("=== dirname ===")
    result = await ws.execute(f"dirname {msg_path}")
    print(await result.stdout_str())

    # realpath
    print("=== realpath ===")
    result = await ws.execute(f"realpath {msg_path}")
    print(await result.stdout_str())

    # Resource-specific commands

    # gws gmail +triage
    print("=== gws gmail +triage ===")
    result = await ws.execute('gws gmail +triage --query "is:unread" --max 3')
    print((await result.stdout_str())[:500])

    # ── glob expansion (exercises resolve_glob → readdir)
    print("=== echo glob: *.gmail.json ===")
    result = await ws.execute(f'echo /gmail/{label}/{first_date}/*.gmail.json')
    out = (await result.stdout_str()).strip()
    print(f"  {out[:200]}")
    assert out, "glob should match at least one file"

    print("=== for f in *.gmail.json (glob loop) ===")
    result = await ws.execute(
        f'for f in /gmail/{label}/{first_date}/*.gmail.json;'
        ' do echo found:$f; done | head -n 3')
    out = (await result.stdout_str()).strip()
    for line in out.splitlines():
        print(f"  {line[:120]}")

    # gws gmail +read (use message_id from filename)
    msg_id = first_msg.rsplit("__", 1)[-1].replace(".gmail.json", "")
    print(f"=== gws gmail +read --id {msg_id} ===")
    result = await ws.execute(f"gws gmail +read --id {msg_id}")
    print((await result.stdout_str())[:500])

    # gws gmail +send
    print("=== gws gmail +send ===")
    result = await ws.execute('gws gmail +send --to "zechengzhang97@gmail.com"'
                              ' --subject "Test from MIRAGE"'
                              ' --body "Sent by gmail.py example"')
    out = await result.stdout_str()
    print(out[:200])

    sent_id = ""
    if out.strip():
        sent = json.loads(out)
        sent_id = sent.get("id", "")

    # gws gmail +reply
    if sent_id:
        print("=== gws gmail +reply ===")
        result = await ws.execute(f'gws gmail +reply --message-id {sent_id}'
                                  ' --body "Reply from MIRAGE"')
        print((await result.stdout_str())[:200])

    # gws gmail +reply-all
    if sent_id:
        print("=== gws gmail +reply-all ===")
        result = await ws.execute(
            f'gws gmail +reply-all --message-id {sent_id}'
            ' --body "Reply-all from MIRAGE"')
        print((await result.stdout_str())[:200])

    # gws gmail +forward
    if sent_id:
        print("=== gws gmail +forward ===")
        result = await ws.execute(f'gws gmail +forward --message-id {sent_id}'
                                  ' --to "zechengzhang97@gmail.com"')
        print((await result.stdout_str())[:200])


if __name__ == "__main__":
    asyncio.run(main())
