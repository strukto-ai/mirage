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

from mirage import MountMode, Workspace
from mirage.resource.ram import RAMResource
from mirage.runtime.types import ScriptSource

# A JS-only world with a JS policy. The quickjs runtime carries the
# evaluator capability, so it doubles as the policy engine: the policy
# script below is JAVASCRIPT, evaluated per line with `ctx` bound as a
# global, and its completion value (the last expression) is the
# verdict. Same contract as python policy scripts on monty:
# a runtime name places the line, null passes, {deny: reason} refuses
# it before anything runs (exit 126).
#
# Needs a quickjs-ng WASI build:
#
#     export MIRAGE_QUICKJS_HOME=/tmp/quickjs   # dir with qjs-wasi.wasm

JS_POLICY = ScriptSource(
    "ctx.commands.some((c) => c.paths.some((p) => p.startsWith('/prod/')))"
    " ? {deny: 'writes under /prod are blocked'}"
    " : null")


async def main() -> None:
    ws = Workspace(
        {
            "/data": RAMResource(),
            "/prod": RAMResource()
        },
        mode=MountMode.EXEC,
        runtimes=["quickjs", "vfs"],
        policy=JS_POLICY,
    )
    try:
        ok = await ws.execute("echo hello > /data/notes.txt")
        print("write /data ->", ok.exit_code)
        served = await ws.execute('node -e "console.log(6 * 7)"')
        print("node -e ->", (await served.stdout_str()).strip())
        denied = await ws.execute("cat /prod/secret.txt")
        print("touch /prod ->", denied.exit_code,
              (await denied.stderr_str()).strip())
    finally:
        await ws.close()


if __name__ == "__main__":
    asyncio.run(main())
