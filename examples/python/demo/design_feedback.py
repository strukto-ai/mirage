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
import logging
import os

from agents import Runner
from agents.run import RunConfig
from agents.sandbox import SandboxAgent, SandboxRunConfig
from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.agents.openai_agents import MirageSandboxClient
from mirage.resource.github import GitHubConfig, GitHubResource
from mirage.resource.linear import LinearConfig, LinearResource
from mirage.resource.ram import RAMResource
from mirage.resource.slack import SlackConfig, SlackResource

load_dotenv(".env.development")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
logging.getLogger("openai.agents").setLevel(logging.DEBUG)

GITHUB_OWNER = os.environ.get("MIRAGE_GITHUB_OWNER", "strukto-ai")
GITHUB_REPO = os.environ.get("MIRAGE_GITHUB_REPO", "mirage")
GITHUB_REF = os.environ.get("MIRAGE_GITHUB_REF", "main")


async def main() -> None:
    slack = SlackResource(config=SlackConfig(
        token=os.environ["SLACK_BOT_TOKEN"],
        search_token=os.environ.get("SLACK_USER_TOKEN"),
    ))
    github = GitHubResource(
        config=GitHubConfig(token=os.environ["GITHUB_TOKEN"]),
        owner=GITHUB_OWNER,
        repo=GITHUB_REPO,
        ref=GITHUB_REF,
    )
    linear = LinearResource(config=LinearConfig(
        api_key=os.environ["LINEAR_API_KEY"]))

    ws = Workspace({
        "/": (RAMResource(), MountMode.WRITE),
        "/slack": (slack, MountMode.READ),
        "/github": (github, MountMode.READ),
        "/linear": (linear, MountMode.WRITE),
    })

    _orig_exec = ws.execute

    async def _trace_exec(cmd_str, *args, **kwargs):
        print(f"[shell] {cmd_str}", flush=True)
        result = await _orig_exec(cmd_str, *args, **kwargs)
        out = (result.stdout or b"")[:200]
        if out:
            print(f"[shell] -> {out!r}", flush=True)
        return result

    ws.execute = _trace_exec  # type: ignore[assignment]

    client = MirageSandboxClient(ws)

    agent = SandboxAgent(
        name="Mirage design feedback agent",
        model="gpt-5.5",
        instructions=ws.file_prompt,
    )

    task = ("Triage the latest user feedback about Mirage from the Slack "
            "incident channel: read the message and any attached screenshot, "
            "find the relevant code in the Mirage GitHub repo, then file a "
            "design issue in the Strukto-ai team on Linear using "
            "`linear-issue-create` with the feedback and code references.")

    result = await Runner.run(
        agent,
        task,
        max_turns=30,
        run_config=RunConfig(sandbox=SandboxRunConfig(client=client)),
    )
    print("\n--- agent output ---")
    print(result.final_output)


if __name__ == "__main__":
    asyncio.run(main())
