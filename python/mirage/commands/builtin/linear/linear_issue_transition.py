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

from mirage.accessor.linear import LinearAccessor
from mirage.commands.registry import command
from mirage.commands.spec.types import (CommandSpec, FlagView, OperandKind,
                                        Option)
from mirage.core.linear._client import (issue_update, list_teams,
                                        resolve_issue_id)
from mirage.core.linear.normalize import normalize_issue
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.resource.linear.config import LinearConfig
from mirage.types import PathSpec

SPEC = CommandSpec(options=(
    Option(long="--issue_id", value_kind=OperandKind.TEXT),
    Option(long="--issue_key", value_kind=OperandKind.TEXT),
    Option(long="--state_id", value_kind=OperandKind.TEXT),
    Option(long="--state_name", value_kind=OperandKind.TEXT),
), )


async def _resolve_state_id(
    config: LinearConfig,
    *,
    state_id: str | None,
    state_name: str | None,
) -> str:
    if state_id:
        return state_id
    if not state_name:
        raise ValueError("state id or state name is required")
    teams = await list_teams(config)
    for team in teams:
        for state in (team.get("states") or {}).get("nodes", []):
            if state.get("name") == state_name:
                return state["id"]
    raise FileNotFoundError(state_name)


@command("linear-issue-transition", resource="linear", spec=SPEC)
async def linear_issue_transition(
    accessor: LinearAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(_extra, spec=SPEC)
    config = accessor.config
    issue_id = await resolve_issue_id(
        config,
        issue_id=fl.as_str("issue_id"),
        issue_key=fl.as_str("issue_key"),
    )
    state_id = await _resolve_state_id(
        config,
        state_id=fl.as_str("state_id"),
        state_name=fl.as_str("state_name"),
    )
    issue = await issue_update(config,
                               issue_id=issue_id,
                               title=None,
                               description=None,
                               state_id=state_id)
    return yield_bytes(
        json.dumps(normalize_issue(issue),
                   ensure_ascii=False,
                   separators=(",", ":")).encode()), IOResult()
