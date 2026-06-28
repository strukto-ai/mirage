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
import sys
from pathlib import Path

from daytona import (CreateSandboxFromImageParams, Daytona, DaytonaConfig,
                     Resources)
from dotenv import load_dotenv
from remote_env import base_image, remote_env

load_dotenv(".env.development")

REMOTE_SCRIPT = Path(__file__).parent / "remote" / "vfs.py"


def main():
    daytona = Daytona(DaytonaConfig(api_key=os.environ["DAYTONA_API_KEY"]))

    print("=== building image (debian-slim + git + mirage-ai[s3]) ===")
    sandbox = daytona.create(
        CreateSandboxFromImageParams(
            image=base_image(),
            resources=Resources(cpu=1, memory=1, disk=1),
        ),
        timeout=600,
        on_snapshot_create_logs=lambda line: print(f"  build: {line}"),
    )
    print(f"\n=== sandbox up: {sandbox.id} ===\n")

    try:
        sandbox.fs.upload_file(REMOTE_SCRIPT.read_bytes(), "/tmp/run.py")
        result = sandbox.process.exec(
            "python /tmp/run.py",
            cwd="/tmp",
            env=remote_env(),
            timeout=120,
        )
        print("=== remote output ===")
        print(result.result.rstrip())
        if result.exit_code != 0:
            print(f"\n=== exit code: {result.exit_code} ===", file=sys.stderr)
            sys.exit(result.exit_code)
    finally:
        print(f"\n=== deleting sandbox {sandbox.id} ===")
        sandbox.delete()


if __name__ == "__main__":
    main()
