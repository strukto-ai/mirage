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
from mirage.resource.gmail import GmailConfig, GmailResource

load_dotenv(".env.development")

config = GmailConfig(
    client_id=os.environ["GOOGLE_CLIENT_ID"],
    client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
    refresh_token=os.environ["GOOGLE_REFRESH_TOKEN"],
)
resource = GmailResource(config=config)


async def show(ws, cmd):
    print(f"\n$ {cmd}")
    r = await ws.execute(cmd)
    out = await r.stdout_str()
    err = await r.stderr_str()
    if out:
        print(f"STDOUT:\n{out}")
    if err:
        print(f"STDERR:\n{err}")
    print(f"exit={r.exit_code}")
    return out, err, r.exit_code


async def main():
    ws = Workspace({"/gmail": resource}, mode=MountMode.READ)

    out, _, _ = await show(ws, "ls /gmail/INBOX/ | head -5")
    dates = [d for d in out.strip().split("\n") if d]
    if not dates:
        print("(no dates in INBOX)")
        return
    first_date = dates[0]

    # A date dir lists message files (*.gmail.json); a message that has
    # attachments also gets a sibling folder named after the message.
    out, _, _ = await show(ws, f"ls /gmail/INBOX/{first_date}")
    entries = [e for e in out.strip().split("\n") if e]
    msg_file = next((e for e in entries if e.endswith(".gmail.json")), None)
    assert msg_file, f"date dir should contain a *.gmail.json msg: {entries}"

    await show(
        ws, f'cat "/gmail/INBOX/{first_date}/{msg_file}" '
        "| jq '{subject, from: .from.email, "
        "attachments: [.attachments[].filename]}'")

    # Find a message with attachments: a date-dir entry without the
    # .gmail.json suffix is the attachment folder for the matching message,
    # so "<name>.gmail.json" is its message file.
    print("\n=== finding a message with attachments ===")
    for d in dates:
        r = await ws.execute(f"ls /gmail/INBOX/{d}")
        items = [e for e in (await r.stdout_str()).strip().split("\n") if e]
        att_dir = next((e for e in items if not e.endswith(".gmail.json")),
                       None)
        if att_dir:
            print(f"FOUND: /gmail/INBOX/{d}/{att_dir}")
            await show(ws, f'ls "/gmail/INBOX/{d}/{att_dir}"')
            await show(
                ws, f'cat "/gmail/INBOX/{d}/{att_dir}.gmail.json" '
                "| jq '.attachments'")
            return
    print("(no attachments found in scanned dates)")


if __name__ == "__main__":
    asyncio.run(main())
