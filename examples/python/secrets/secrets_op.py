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
from pathlib import Path

from mirage import Workspace
from mirage.config import load_config

CONFIG = Path(__file__).with_name("workspace.yaml")

# What the declared instance reads for its own credential. The dotenv
# path in the yaml is cwd-relative, so run this from the repo root the
# way every other example is run.
DOTENV = Path(".env.development")
NEEDS = ("OP_SERVICE_ACCOUNT_TOKEN", )

# Every line the agent runs here is ordinary bash: a managed variable
# is spelled `$SLACK_BOT_TOKEN`, never as a pointer, so nothing on the
# line tells the model a secret is involved. What each line prints is
# a length or a prefix, never a whole value -- the point is to show
# the real secret arrived, not to put it on a terminal.
LINES = [
    # A literal needs no source and no fetch.
    'echo "environment: $MIRAGE_ENV"',
    # A line naming no secret fetches nothing at all.
    "echo 'this line reads no secret' > /data/note.txt; cat /data/note.txt",
    # An item reference read through `key: credential`. A slack bot
    # token starts `xoxb-`, so the prefix is proof the value is real.
    'printf %s "$SLACK_BOT_TOKEN" | cut -c1-5',
    'echo "bot token: ${#SLACK_BOT_TOKEN} chars"',
    # A field reference, the shape 1Password copies out of the app.
    'echo "user token: ${#SLACK_USER_TOKEN} chars"',
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
    # The same file either CLI would load, so the sources and the
    # variables are declared once and this script only runs lines.
    if not DOTENV.exists():
        print(f"no {DOTENV} at the cwd. Every line below will fail on the "
              "source's own config rather than on the line, which is what "
              "resolving the `secrets:` block once, before the first line, "
              f"buys: a deployment error is not a per-command one.\n"
              f"To see it work, run from the repo root with {DOTENV} "
              f"holding {', '.join(NEEDS)}.\n")
    config = load_config(CONFIG)
    ws = Workspace(**config.to_workspace_kwargs())
    for line in LINES:
        await show(ws, line)
    await ws.close()


if __name__ == "__main__":
    asyncio.run(main())
