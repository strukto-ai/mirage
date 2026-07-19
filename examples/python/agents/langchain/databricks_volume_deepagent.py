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

from databricks_langchain import ChatDatabricks
from deepagents import create_deep_agent
from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.agents.langchain import (LangchainWorkspace, build_system_prompt,
                                     extract_text)
from mirage.resource.databricks_volume import (DatabricksVolumeConfig,
                                               DatabricksVolumeResource)

load_dotenv(".env.development")

resource = DatabricksVolumeResource(
    DatabricksVolumeConfig(
        catalog=os.environ["DATABRICKS_VOLUME_CATALOG"],
        schema=os.environ["DATABRICKS_VOLUME_SCHEMA"],
        volume=os.environ["DATABRICKS_VOLUME_NAME"],
        root_path=os.environ.get("DATABRICKS_VOLUME_ROOT_PATH", "/"),
        host=os.environ.get("DATABRICKS_HOST"),
        token=os.environ.get("DATABRICKS_TOKEN"),
        profile=os.environ.get("DATABRICKS_CONFIG_PROFILE"),
    ))

ws = Workspace({"/dbx/": resource}, mode=MountMode.READ)

agent = create_deep_agent(
    model=ChatDatabricks(endpoint=os.environ["DATABRICKS_CHAT_ENDPOINT"], ),
    system_prompt=build_system_prompt(workspace=ws),
    backend=LangchainWorkspace(ws),
)

task = ("Inspect /dbx/, identify the most relevant text or markdown files, "
        "and summarize their contents. Use head for large files.")
result = agent.invoke({"messages": [{"role": "user", "content": task}]})

for text in extract_text(result["messages"][-1:]):
    print(text)

records = ws.ops.records
if records:
    total = sum(record.bytes for record in records)
    print(f"\n--- {len(records)} ops, {total:,} bytes ---")
    for record in records:
        print(f"  {record.op:<8} {record.source:<18} {record.bytes:>10,} B "
              f"{record.duration_ms:>5} ms  {record.path}")
