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

import pytest

from mirage import Action, CommandContext, Deny, GuardSpec, Policy, Workspace
from mirage.resource.ram import RAMResource
from mirage.types import MountMode


class NoInterpreters(Policy):

    async def pre_command(self, ctx: CommandContext) -> Action | None:
        if ctx.command == "python3":
            return Deny("python3: interpreters are off\n")
        return None


@pytest.mark.asyncio
async def test_workspace_guards_refuse_before_backend_io():
    ws = Workspace({"/data/": RAMResource()},
                   mode=MountMode.WRITE,
                   guards=[
                       GuardSpec(reason="production data is protected",
                                 commands=("rm", ),
                                 paths=("/data/prod/*", ))
                   ])
    try:
        await ws.execute("mkdir -p /data/prod")
        await ws.ops.write("/data/prod/x.txt", b"keep\n")
        result = await ws.execute("rm /data/prod/x.txt")
        assert result.exit_code == 1
        assert result.stderr == (b"rm: /data/prod/x.txt: "
                                 b"production data is protected\n")
        out = await ws.execute("cat /data/prod/x.txt")
        assert out.stdout == b"keep\n"
        ok = await ws.execute("rm -f /data/prod/../other.txt 2>/dev/null; "
                              "echo done")
        assert b"done" in ok.stdout
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_policies_add_wins_over_runtime_placement():
    # python3 is runtime-bound in the default world; the pre_command
    # hook fires ahead of runtime resolution, so the refusal wins.
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    try:
        ws.policies.add(NoInterpreters())
        result = await ws.execute("python3 -c 'print(1)'")
        assert result.exit_code == 1
        assert result.stderr == b"python3: interpreters are off\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_policies_constructor_param_accepts_instances():
    ws = Workspace({"/data/": RAMResource()},
                   mode=MountMode.WRITE,
                   policies=[NoInterpreters()])
    try:
        result = await ws.execute("python3 -c 'print(1)'")
        assert result.exit_code == 1
        assert result.stderr == b"python3: interpreters are off\n"
    finally:
        await ws.close()
