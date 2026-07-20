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
import time
from dataclasses import dataclass

from dotenv import load_dotenv
from pydantic_ai import Agent
from pydantic_ai_backends import create_console_toolset

from mirage import MountMode, Workspace
from mirage.agents.pydantic_ai import PydanticAIWorkspace
from mirage.resource.slack import SlackConfig, SlackResource

load_dotenv(".env.development")

slack = SlackResource(
    config=SlackConfig(token=os.environ["SLACK_BOT_TOKEN"],
                       search_token=os.environ.get("SLACK_USER_TOKEN")))
ws = Workspace({"/slack": slack}, mode=MountMode.READ)


@dataclass
class Deps:
    backend: PydanticAIWorkspace


backend = PydanticAIWorkspace(ws)

agent = Agent(
    "openai:gpt-5.4-mini",
    system_prompt=ws.file_prompt,
    deps_type=Deps,
    toolsets=[
        create_console_toolset(require_execute_approval=False,
                               image_support=True,
                               document_support=True)
    ],
)


def main() -> None:
    task = (
        "Read and summarize the latest PNG and PDF in the slack "
        "general channel. Open each file with read_file before responding.")
    print(f"=== Task: {task} ===")
    print()
    t0 = time.perf_counter()
    result = agent.run_sync(task, deps=Deps(backend=backend))
    elapsed = time.perf_counter() - t0
    print(result.output)
    print()
    print(f"--- {elapsed:.1f}s ---")

    records = ws.ops.records
    if records:
        total = sum(r.bytes for r in records)
        print(f"--- {len(records)} ops, {total:,} bytes ---")
        for r in records:
            print(f"  {r.op:<8} {r.source:<8} {r.bytes:>10,} B "
                  f"{r.duration_ms:>5} ms  {r.path}")


if __name__ == "__main__":
    main()
