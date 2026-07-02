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
from mirage.resource.email import EmailConfig, EmailResource
from mirage.types import PathSpec

load_dotenv(".env.development")

config = EmailConfig(
    imap_host=os.environ["IMAP_HOST"],
    smtp_host=os.environ["SMTP_HOST"],
    username=os.environ["EMAIL_USERNAME"],
    password=os.environ["EMAIL_PASSWORD"],
    max_messages=20,
)
resource = EmailResource(config=config)


async def main() -> None:
    ws = Workspace({"/email": resource}, mode=MountMode.READ)

    print("=== not-found errors show the full virtual path ===")
    for cmd in ("cat /email/__nf_missing__.txt",
                "head /email/__nf_missing__.txt",
                "stat /email/__nf_missing__.txt"):
        result = await ws.execute(cmd)
        print(f"$ {cmd}")
        print(f"  exit={result.exit_code}  "
              f"{(await result.stderr_str()).strip()}")

    print("=== ls /email/ ===")
    result = await ws.execute("ls /email/")
    print(await result.stdout_str())

    folders = (await result.stdout_str()).strip().splitlines()
    folder = "Inbox"
    if not any("Inbox" in f or "INBOX" in f for f in folders):
        folder = folders[0] if folders else ""
    if not folder:
        print("No folders")
        return

    print(f"=== ls /email/{folder}/ ===")
    result = await ws.execute(f"ls /email/{folder}/")
    print(await result.stdout_str())

    dates = (await result.stdout_str()).strip().splitlines()
    if not dates:
        print("No dates")
        return
    first_date = dates[0]

    print(f"=== ls /email/{folder}/{first_date}/ ===")
    result = await ws.execute(f"ls /email/{folder}/{first_date}/")
    print(await result.stdout_str())

    messages = (await result.stdout_str()).strip().splitlines()
    msg_files = [m for m in messages if m.endswith(".email.json")]
    if not msg_files:
        print("No messages")
        return
    first_msg = f"/email/{folder}/{first_date}/{msg_files[0]}"

    print(f"=== cat {first_msg} ===")
    result = await ws.execute(f"cat {first_msg}")
    print((await result.stdout_str())[:500])

    print(f"\n=== jq .subject {first_msg} ===")
    result = await ws.execute(f'jq ".subject" {first_msg}')
    print(await result.stdout_str())

    print(f"=== jq .from {first_msg} ===")
    result = await ws.execute(f'jq ".from" {first_msg}')
    print(await result.stdout_str())

    # chmod/chown/touch never hit the IMAP API: attrs land in the
    # workspace namespace (durable, snapshot-captured) and merge into
    # dispatch-level stat.
    print(f"=== metadata overlay on {first_msg} ===")
    meta_res = await ws.execute(f'chmod 640 "{first_msg}"'
                                f' && chown 500:dev "{first_msg}"'
                                f' && touch -t 202601021530 "{first_msg}"')
    print(f"  chmod/chown/touch exit={meta_res.exit_code}")
    meta_st, _ = await ws.dispatch("stat",
                                   PathSpec.from_str_path(f"{first_msg}"))
    print(f"  dispatch stat: mode={oct(meta_st.mode)[2:]} uid={meta_st.uid} "
          f"gid={meta_st.gid} mtime={meta_st.modified}")

    print("=== email-triage --unseen --max 5 ===")
    result = await ws.execute(
        f'email-triage --folder {folder} --unseen --max 5')
    print((await result.stdout_str())[:500])

    print(f"\n=== tree -L 2 /email/{folder}/ ===")
    result = await ws.execute(f"tree -L 2 /email/{folder}/")
    print((await result.stdout_str())[:500])

    # ── native search dispatch (IMAP TEXT search via -r at folder level) ──
    for label, cmd in [
        (f"grep -r Hi /email/{folder}/ (folder scope, IMAP search)",
         f"grep -r Hi /email/{folder}/"),
        (f"rg Hi /email/{folder}/ (folder scope)", f"rg Hi /email/{folder}/"),
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


if __name__ == "__main__":
    asyncio.run(main())
