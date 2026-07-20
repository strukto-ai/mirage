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


async def main():
    ws = Workspace({"/gmail": resource}, mode=MountMode.WRITE)

    r = await ws.execute("ls /gmail/")
    print("=== labels ===")
    print(await r.stdout_str())

    r = await ws.execute("ls /gmail/INBOX/ | head -n 3")
    print("=== INBOX (first 3) ===")
    print(await r.stdout_str())

    first = (await r.stdout_str()).strip().split("\n")[0]

    print("=== plan: cat ===")
    dr = await ws.execute(f"cat /gmail/INBOX/{first}", provision=True)
    print(f"  network_read={dr.network_read}, precision={dr.precision}")

    print("=== cat message ===")
    r = await ws.execute(f"cat /gmail/INBOX/{first}")
    print((await r.stdout_str())[:500])

    print("=== jq .subject ===")
    r = await ws.execute(f'jq ".subject" /gmail/INBOX/{first}')
    print(await r.stdout_str())

    print("=== gws gmail +triage ===")
    r = await ws.execute('gws gmail +triage --query "is:unread" --max 5')
    print((await r.stdout_str())[:500])

    print("=== gws gmail +send ===")
    r = await ws.execute(
        'gws gmail +send --to "zechengzhang97@gmail.com"'
        ' --subject "Hello from MIRAGE"'
        ' --body "This email was sent via the MIRAGE Gmail resource."')
    print((await r.stdout_str())[:200])


if __name__ == "__main__":
    asyncio.run(main())
