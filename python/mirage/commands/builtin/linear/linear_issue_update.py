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
from collections.abc import AsyncIterator

from mirage.accessor.linear import LinearAccessor
from mirage.commands.builtin.linear._input import resolve_text_input
from mirage.commands.registry import command
from mirage.commands.spec.types import CommandSpec, OperandKind, Option
from mirage.core.linear._client import issue_update, resolve_issue_id
from mirage.core.linear.normalize import normalize_issue
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

SPEC = CommandSpec(options=(
    Option(long="--issue_id", value_kind=OperandKind.TEXT),
    Option(long="--issue_key", value_kind=OperandKind.TEXT),
    Option(long="--title", value_kind=OperandKind.TEXT),
    Option(long="--description", value_kind=OperandKind.TEXT),
    Option(long="--description_file", value_kind=OperandKind.PATH),
), )


@command("linear-issue-update", resource="linear", spec=SPEC)
async def linear_issue_update(
    accessor: LinearAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
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
    title = _extra.get("title") if isinstance(_extra.get("title"),
                                              str) else None
    description = None
    if (_extra.get("description") is not None
            or _extra.get("description_file") is not None
            or stdin is not None):
        description = await resolve_text_input(
            config,
            inline_text=_extra.get("description") if isinstance(
                _extra.get("description"), str) else None,
            file_path=_extra.get("description_file") if isinstance(
                _extra.get("description_file"), str) else None,
            stdin=stdin,
            error_message="description is required",
        )
    issue = await issue_update(config,
                               issue_id=issue_id,
                               title=title,
                               description=description)
    return yield_bytes(
        json.dumps(normalize_issue(issue),
                   ensure_ascii=False,
                   separators=(",", ":")).encode()), IOResult()
