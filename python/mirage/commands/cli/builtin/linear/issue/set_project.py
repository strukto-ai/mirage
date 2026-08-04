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

from mirage.commands.cli.builtin.linear.util import (first_text, resolve_issue,
                                                     resolve_project_id)
from mirage.commands.spec.types import FlagView
from mirage.core.linear._client import get_issue, issue_update
from mirage.core.linear.config import LinearConfig
from mirage.core.linear.normalize import normalize_issue, to_json_bytes
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def set_project(
    config: LinearConfig,
    paths: list[PathSpec],
    *texts: str,
    **flags: object,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(flags)
    issue_id = await resolve_issue(config, first_text(texts, "issue key"))
    project_id = fl.as_str("project")
    if not project_id:
        issue = await get_issue(config, issue_id)
        team_id = (issue.get("team") or {}).get("id") or ""
        project_id = await resolve_project_id(config, team_id, None,
                                              fl.as_str("project_name"))
    updated = await issue_update(config,
                                 issue_id=issue_id,
                                 title=None,
                                 description=None,
                                 project_id=project_id)
    return yield_bytes(to_json_bytes(normalize_issue(updated))), IOResult()
