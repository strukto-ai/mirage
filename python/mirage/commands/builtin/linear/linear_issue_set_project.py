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
from mirage.core.linear._client import issue_update, resolve_issue_id
from mirage.core.linear.normalize import normalize_issue
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

SPEC = CommandSpec(options=(
    Option(long="--issue_id", value_kind=OperandKind.TEXT),
    Option(long="--issue_key", value_kind=OperandKind.TEXT),
    Option(long="--project_id", value_kind=OperandKind.TEXT),
), )


@command("linear issue set-project", resource="linear", spec=SPEC)
async def linear_issue_set_project(
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
    project_id = _extra.get("project_id")
    if not project_id or not isinstance(project_id, str):
        raise ValueError("--project_id is required")
    issue = await issue_update(config,
                               issue_id=issue_id,
                               title=None,
                               description=None,
                               project_id=project_id)
    return yield_bytes(
        json.dumps(normalize_issue(issue),
                   ensure_ascii=False,
                   separators=(",", ":")).encode()), IOResult()
