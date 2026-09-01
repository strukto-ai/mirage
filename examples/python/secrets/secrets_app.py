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

# The application's own environment, loaded first. It carries two
# different credentials for two different planes: the slack token the
# mount is built from here, and the 1Password service account token
# the `op` source authenticates with.
load_dotenv(".env.development")

resource = SlackResource(config=SlackConfig(
    token=os.environ["SLACK_BOT_TOKEN"],
    search_token=os.environ.get("SLACK_USER_TOKEN"),
))

LINES = [
    # The mount, built from the dotenv value above.
    "ls /slack | head -n 3",
    # The session's own variables, fetched from 1Password by the line
    # that reads them. Lengths, not values.
    'echo "bot token: ${#SLACK_BOT_TOKEN} chars"',
    'echo "user token: ${#SLACK_USER_TOKEN} chars"',
    # A session write beats the pointer and outlives the line. The
    # mount keeps the token it was built with either way.
    "export SLACK_BOT_TOKEN=overridden-in-session",
    'echo "bot token now: $SLACK_BOT_TOKEN"',
    "ls /slack | head -n 1",
]


async def show(ws: Workspace, line: str) -> None:
    """Run one line and print what the agent would see.

    Args:
        ws (Workspace): the workspace to run in.
        line (str): the shell line.
    """
    result = await ws.execute(line)
    print(f"$ {line}")
    print(f"  exit {result.exit_code}")
    for stream, text in (("out", await
                          result.stdout_str()), ("err", await
                                                 result.stderr_str())):
        if text.strip():
            print(f"  {stream}: {text.strip()}")
    print()


async def main() -> None:
    ws = Workspace(
        {"/slack": resource},
        mode=MountMode.READ,
        # The source's own credential comes from the process env that
        # load_dotenv just filled.
        secrets={
            "op": {
                "source": "1password",
                "config": {
                    "token": {
                        "from": "env",
                        "key": "OP_SERVICE_ACCOUNT_TOKEN"
                    },
                },
            },
        },
        env={
            "SLACK_BOT_TOKEN": {
                "from": "op",
                "ref": "op://mirage/SLACK_BOT_TOKEN",
                "key": "credential",
            },
            "SLACK_USER_TOKEN": {
                "from": "op",
                "ref": "op://mirage/SLACK_USER_TOKEN",
                "key": "credential",
            },
        },
    )
    for line in LINES:
        await show(ws, line)
    await ws.close()


if __name__ == "__main__":
    asyncio.run(main())
