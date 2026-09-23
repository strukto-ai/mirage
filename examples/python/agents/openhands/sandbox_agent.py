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

import os

from dotenv import load_dotenv
from openhands.sdk import LLM, Agent, Conversation, Tool

from mirage import MountMode, Workspace
from mirage.agents.openhands import MirageWorkspace, register_mirage_terminal
from mirage.vfs.ram import RAMVFS
from mirage.vfs.s3 import S3VFS, S3Config
from mirage.vfs.slack import SlackConfig, SlackVFS

load_dotenv(".env.development")

TASK = (
    "Find any Slack messages containing the word 'hello' (case-insensitive) "
    "in the general channel. The channel directory is at "
    "/slack/channels/ and starts with 'general'. Each day's messages live "
    "in a <yyyy-mm-dd>.jsonl file. Use `ls` to discover the exact channel "
    "directory, then `grep -i hello` across its jsonl files. Report the "
    "matching message texts and stop.")


def build_workspace() -> Workspace:
    s3 = S3VFS(
        S3Config(
            bucket=os.environ["AWS_S3_BUCKET"],
            region=os.environ.get("AWS_DEFAULT_REGION", "us-east-1"),
            aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
        ))
    slack = SlackVFS(config=SlackConfig(
        token=os.environ["SLACK_BOT_TOKEN"],
        search_token=os.environ.get("SLACK_USER_TOKEN"),
    ))
    return Workspace(
        {
            "/": (RAMVFS(), MountMode.WRITE),
            "/s3": (s3, MountMode.READ),
            "/slack": (slack, MountMode.READ),
        },
        mode=MountMode.WRITE,
    )


def main() -> None:
    ws = build_workspace()
    llm = LLM(
        model=os.getenv("LLM_MODEL", "anthropic/claude-sonnet-4-6"),
        api_key=os.getenv("LLM_API_KEY"),
        base_url=os.getenv("LLM_BASE_URL", None),
    )

    with MirageWorkspace(workspace=ws, working_dir="/") as mirage_ws:
        tool_name = register_mirage_terminal(mirage_ws)
        agent = Agent(
            llm=llm,
            tools=[Tool(name=tool_name)],
            system_message=ws.file_prompt,
        )
        conversation = Conversation(agent=agent, workspace=mirage_ws)
        conversation.send_message(TASK)
        conversation.run()


if __name__ == "__main__":
    main()
