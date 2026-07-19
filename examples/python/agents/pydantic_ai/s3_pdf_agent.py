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
from dataclasses import dataclass

from dotenv import load_dotenv
from pydantic_ai import Agent
from pydantic_ai_backends import create_console_toolset

from mirage import MountMode, Workspace
from mirage.agents.pydantic_ai import PydanticAIWorkspace, build_system_prompt
from mirage.resource.s3 import S3Config, S3Resource

load_dotenv(".env.development")

config = S3Config(
    bucket=os.environ["AWS_S3_BUCKET"],
    region=os.environ.get("AWS_DEFAULT_REGION", "us-east-1"),
    aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
    aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
)

s3 = S3Resource(config)
ws = Workspace({"/s3/": s3}, mode=MountMode.READ)


@dataclass
class Deps:
    backend: PydanticAIWorkspace


backend = PydanticAIWorkspace(ws)

agent = Agent(
    "anthropic:claude-sonnet-4-6",
    system_prompt=build_system_prompt(
        mount_info={"/s3/": "S3 bucket with PDF documents"}),
    deps_type=Deps,
    toolsets=[create_console_toolset(document_support=True)],
)

task = ("Read the PDF at /s3/data/example.pdf."
        " Summarize the first 5 pages of the paper.")
result = agent.run_sync(task, deps=Deps(backend=backend))
print(result.output)

records = ws.ops.records
if records:
    total = sum(r.bytes for r in records)
    print(f"\n--- {len(records)} ops, {total:,} bytes ---")
    for r in records:
        print(f"  {r.op:<8} {r.source:<8} {r.bytes:>10,} B "
              f"{r.duration_ms:>5} ms  {r.path}")
