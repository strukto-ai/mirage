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
from mirage.commands.spec.types import CommandSpec, OperandKind, Option
from mirage.core.linear._client import (get_issue, issue_update,
                                        resolve_issue_id)
from mirage.core.linear.normalize import normalize_issue
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

SPEC = CommandSpec(options=(
    Option(long="--issue_id", value_kind=OperandKind.TEXT),
    Option(long="--issue_key", value_kind=OperandKind.TEXT),
    Option(long="--label_id", value_kind=OperandKind.TEXT),
), )


@command("linear-issue-add-label", resource="linear", spec=SPEC)
async def linear_issue_add_label(
    accessor: LinearAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    config = accessor.config
    issue_id = await resolve_issue_id(
        config,
        issue_id=_extra.get("issue_id")
        if isinstance(_extra.get("issue_id"), str) else None,
        issue_key=_extra.get("issue_key") if isinstance(
            _extra.get("issue_key"), str) else None,
    )
    label_id = _extra.get("label_id")
    if not label_id or not isinstance(label_id, str):
        raise ValueError("--label_id is required")
    issue = await get_issue(config, issue_id)
    nodes = issue.get("labels", {}).get("nodes", [])
    existing = [n["id"] for n in nodes]
    if label_id not in existing:
        existing.append(label_id)
    updated = await issue_update(config,
                                 issue_id=issue_id,
                                 title=None,
                                 description=None,
                                 label_ids=existing)
    return yield_bytes(
        json.dumps(normalize_issue(updated),
                   ensure_ascii=False,
                   separators=(",", ":")).encode()), IOResult()
