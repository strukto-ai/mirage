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
import json
import os
import sys

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.resource.hf_models import HfModelsConfig, HfModelsResource

load_dotenv(".env.development")

config = HfModelsConfig(
    repo_id=os.environ.get("HF_MODEL_REPO", "sapientinc/HRM-Text-1B"),
    token=os.environ.get("HF_TOKEN"),
)
resource = HfModelsResource(config)


async def main():
    with Workspace({"/m/": resource}, mode=MountMode.READ) as ws:
        vos = sys.modules["os"]
        print(f"=== VFS: {resource.accessor.bucket_uri} ===")

        print("\n--- os.listdir('/m') ---")
        root_entries = vos.listdir("/m")
        for e in root_entries:
            print(f"  {e}")

        if "config.json" in root_entries:
            print("\n--- read /m/config.json + parse ---")
            with open("/m/config.json") as f:
                cfg = json.load(f)
            for k in ("model_type", "architectures", "hidden_size",
                      "num_hidden_layers"):
                if k in cfg:
                    print(f"  {k}: {cfg[k]}")

        weight_files = [e for e in root_entries if e.endswith(".safetensors")]
        if weight_files:
            print("\n--- weights present (sizes only, not downloaded) ---")
            for wf in weight_files[:5]:
                size = vos.path.getsize(f"/m/{wf}")
                print(f"  {wf}: {size:>12,} bytes")

        print("\n--- shell view ---")
        r = await ws.execute("ls -lh /m/")
        print(await r.stdout_str())


asyncio.run(main())
