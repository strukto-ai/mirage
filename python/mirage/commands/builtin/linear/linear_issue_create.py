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
from mirage.core.linear._client import issue_create
from mirage.core.linear.normalize import normalize_issue
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

SPEC = CommandSpec(options=(
    Option(long="--team_id", value_kind=OperandKind.TEXT),
    Option(long="--title", value_kind=OperandKind.TEXT),
    Option(long="--description", value_kind=OperandKind.TEXT),
    Option(long="--description_file", value_kind=OperandKind.PATH),
), )


@command("linear issue create", resource="linear", spec=SPEC, write=True)
async def linear_issue_create(
    accessor: LinearAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(_extra, spec=SPEC)
    config = accessor.config
    team_id = _extra.get("team_id")
    if not team_id or not isinstance(team_id, str):
        raise ValueError("--team_id is required")
    title = _extra.get("title")
    if not title or not isinstance(title, str):
        raise ValueError("--title is required")
    description = None
    if (_extra.get("description") or _extra.get("description_file")
            or stdin is not None):
        description = await resolve_text_input(
            config,
            inline_text=fl.as_str("description"),
            file_path=fl.as_str("description_file"),
            stdin=stdin,
            error_message="description is required",
        )
    issue = await issue_create(
        config,
        team_id=team_id,
        title=title,
        description=description,
    )
    return yield_bytes(
        json.dumps(normalize_issue(issue),
                   ensure_ascii=False,
                   separators=(",", ":")).encode()), IOResult()
