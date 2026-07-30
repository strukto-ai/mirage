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
import sys

from e2b import AsyncSandbox


async def main() -> int:
    """Provision or kill the e2b sandbox the runtime suite connects to.

    Mirage never creates or deletes sandboxes; this helper is the
    user-provisioned side of the contract, run by CI (or by hand)
    around the runners. ``create`` prints the sandbox id to stdout;
    ``kill <id>`` tears it down.
    """
    action = sys.argv[1]
    if action == "create":
        sandbox = await AsyncSandbox.create(timeout=3600)
        print(sandbox.sandbox_id)
        return 0
    if action == "kill":
        await AsyncSandbox.kill(sys.argv[2])
        return 0
    print(f"unknown action: {action!r} (expected create|kill)",
          file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
