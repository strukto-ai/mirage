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

from mirage.io.types import materialize
from mirage.policy.types import HandOff
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.executor.command.command import handle_command
from mirage.workspace.executor.command.resolved import ResolvedCommand
from mirage.workspace.executor.deps import ExecuteNodeDeps
from mirage.workspace.expand.argv import Argv
from mirage.workspace.lookup.lookup import resolve_target
from mirage.workspace.lookup.types import FunctionTarget
from mirage.workspace.node.execute_node import execute_node


@pytest.mark.asyncio
async def test_bound_function_keeps_its_site_after_identical_redefinition():
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    body = 'f() { say "${BASH_SOURCE[0]}" "$LINENO"; }'
    try:
        await ws.shell(
            f"printf '%s\\n' '{body}' > /first; printf '\\n%s\\n' '{body}' > /second"
        )
        await ws.shell("shopt -s expand_aliases")
        await ws.shell("alias say='echo before'; source /first")
        session = ws.get_session(ws.default_session_id)
        target = resolve_target("f", (), session, ws.registry)
        assert isinstance(target, FunctionTarget)
        origin = session._function_sites["f"].origin
        assert origin is not None

        await ws.shell("alias say='echo after'; source /second")
        assert session.functions["f"] == target.body
        assert (await ws.shell("f")).stdout == b"after /second 2\n"

        deps = ExecuteNodeDeps(
            ws.dispatch,
            ws.registry,
            ws.namespace,
            ws.job_table,
            ws.shell,
            handed=HandOff(),
        )
        origins = []

        async def run(*args, **opts):
            origins.append(opts["handed"].origin)
            return await execute_node(deps, *args, **opts)

        out, io, _ = await handle_command(
            deps,
            run,
            ResolvedCommand(Argv("f", (), ()), target),
            EvaluationContext(session),
        )
        assert (await materialize(out), io.exit_code) == (
            b"before /first 1\n",
            0,
        )
        assert len(origins) == 1 and origins[0] is origin
    finally:
        await ws.close()
