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

import json

from mirage.runtime.base import Runtime
from mirage.runtime.policy.types import ParsedCommand, PolicyContext
from mirage.runtime.types import RunArgs, RunResult


class StubRuntime(Runtime):
    name = "monty"
    captures = ("python3", )

    async def run(self, args: RunArgs) -> RunResult:
        return RunResult(stdout=b"", stderr=None, exit_code=0)


def sample_ctx() -> PolicyContext:
    return PolicyContext(
        line="slack send /data/x | python3 p.py",
        commands=(ParsedCommand(command="slack",
                                words=("slack", "send", "/data/x"),
                                builtin=False,
                                paths=("/data/x", ),
                                cli="slack"),
                  ParsedCommand(command="python3",
                                words=("python3", "p.py"),
                                builtin=True,
                                paths=())),
        command="slack",
        builtin=False,
        cwd="/data",
        env={"K": "V"},
        session_id="s1",
        agent_id="a1",
        mounts=("/data", ),
    )


def test_wire_schema_round_trips_through_json():
    """The to_dict payload survives a JSON file and from_dict replay."""
    ctx = sample_ctx()
    payload = json.loads(json.dumps(ctx.to_dict()))
    assert PolicyContext.from_dict(payload) == ctx


def test_from_dict_ignores_the_runtime_decoration():
    ctx = sample_ctx()
    payload = ctx.to_dict(StubRuntime())
    assert payload["runtime"] == {"name": "monty", "captures": ["python3"]}
    assert PolicyContext.from_dict(payload) == ctx
