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
from mirage.commands.builtin.linear._input import resolve_text_input
from mirage.commands.registry import command
from mirage.commands.spec.types import (CommandSpec, FlagView, OperandKind,
                                        Option)
from mirage.core.linear._client import comment_create, resolve_issue_id
from mirage.core.linear.normalize import normalize_comment
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

SPEC = CommandSpec(options=(
    Option(long="--issue_id", value_kind=OperandKind.TEXT),
    Option(long="--issue_key", value_kind=OperandKind.TEXT),
    Option(long="--body", value_kind=OperandKind.TEXT),
    Option(long="--body_file", value_kind=OperandKind.PATH),
), )


@command("linear comment add", resource="linear", spec=SPEC, write=True)
async def linear_issue_comment_add(
    accessor: LinearAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(_extra, spec=SPEC)
    config = accessor.config
    issue_id = await resolve_issue_id(
        config,
        issue_id=fl.as_str("issue_id"),
        issue_key=fl.as_str("issue_key"),
    )
    body = await resolve_text_input(
        config,
        inline_text=fl.as_str("body"),
        file_path=fl.as_str("body_file"),
        stdin=stdin,
        error_message="comment body is required",
    )
    comment = await comment_create(config, issue_id=issue_id, body=body)
    payload = normalize_comment(comment, issue_id=issue_id, issue_key=None)
    return yield_bytes(
        json.dumps(payload, ensure_ascii=False,
                   separators=(",", ":")).encode()), IOResult()
