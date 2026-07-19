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

from pathlib import Path

from deepagents import create_deep_agent
from dotenv import load_dotenv
from langchain_anthropic import ChatAnthropic

from mirage import MountMode, RAMResource, Workspace
from mirage.agents.langchain import LangchainWorkspace, extract_text

load_dotenv(".env.development")

ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
backend = LangchainWorkspace(ws)
backend.upload_files([("/example.pdf", Path("data/example.pdf").read_bytes())])

agent = create_deep_agent(
    model=ChatAnthropic(model="claude-sonnet-4-6"),
    backend=backend,
)

task = ("Read /example.pdf and explain the paper's purpose and main idea "
        "in two concise sentences.")
result = agent.invoke({"messages": [{"role": "user", "content": task}]})

for text in extract_text(result["messages"][-1:]):
    print(text)

pdf_read_count = sum(record.op == "read" and record.path == "/example.pdf"
                     for record in ws.ops.records)
print(f"\nPDF reads through Mirage: {pdf_read_count}")
