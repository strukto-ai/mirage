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

from mirage.commands.cli.builtin.linear.util import text_or_stdin
from mirage.commands.spec.types import FlagView
from mirage.core.linear._client import issue_create, resolve_team
from mirage.core.linear.config import LinearConfig
from mirage.core.linear.normalize import normalize_issue, to_json_bytes
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def create(
    config: LinearConfig,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    **flags: object,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(flags)
    team = await resolve_team(config, fl.as_str("team") or "")
    description = None
    if fl.as_str("description") is not None or stdin is not None:
        description = await text_or_stdin(fl.as_str("description"), stdin,
                                          "description is required")
    issue = await issue_create(
        config,
        team_id=team["id"],
        title=fl.as_str("title") or "",
        description=description,
    )
    return yield_bytes(to_json_bytes(normalize_issue(issue))), IOResult()
