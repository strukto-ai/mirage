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
from mirage.core.linear._client import comment_update
from mirage.core.linear.normalize import normalize_comment
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

SPEC = CommandSpec(options=(
    Option(long="--comment_id", value_kind=OperandKind.TEXT),
    Option(long="--body", value_kind=OperandKind.TEXT),
    Option(long="--body_file", value_kind=OperandKind.PATH),
), )


@command("linear-issue-comment-update",
         resource="linear",
         spec=SPEC,
         write=True)
async def linear_issue_comment_update(
    accessor: LinearAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    config = accessor.config
    comment_id = _extra.get("comment_id")
    if not comment_id or not isinstance(comment_id, str):
        raise ValueError("--comment_id is required")
    body = await resolve_text_input(
        config,
        inline_text=_extra.get("body")
        if isinstance(_extra.get("body"), str) else None,
        file_path=_extra.get("body_file") if isinstance(
            _extra.get("body_file"), str) else None,
        stdin=stdin,
        error_message="comment body is required",
    )
    comment = await comment_update(config, comment_id=comment_id, body=body)
    issue = comment.get("issue") if isinstance(comment, dict) else None
    if isinstance(issue, dict) and issue.get("id"):
        payload = normalize_comment(comment,
                                    issue_id=issue["id"],
                                    issue_key=issue.get("identifier"))
    else:
        payload = comment
    return yield_bytes(json.dumps(payload,
                                  ensure_ascii=False,
                                  separators=(",", ":")).encode()), IOResult()
