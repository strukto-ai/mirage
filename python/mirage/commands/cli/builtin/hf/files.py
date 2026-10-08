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

from mirage.commands.cli.builtin.hf.accessor import (
    hub_for,
    repo_type_of,
    require_operands,
    require_token,
    text_out,
)
from mirage.commands.cli.types import CLIInvocation
from mirage.commands.spec.flag_view import FlagView
from mirage.core.hf_hub.client import repo_url
from mirage.core.hf_hub.commit import commit
from mirage.core.hf_hub.config import HfConfig
from mirage.core.hf_hub.constants import EMPTY_COMMIT_WARNING
from mirage.core.hf_hub.repo import head_commit
from mirage.core.hf_hub.tree import deletions_for, fetch_tree, repo_files
from mirage.io.types import ByteSource, IOResult


async def delete_cmd(
    inv: CLIInvocation[HfConfig],
) -> tuple[ByteSource | None, IOResult]:
    """Delete the files a set of glob patterns matches, in one commit.

    huggingface_hub's ``delete_files``: the patterns match the
    repository's listing (``*`` crosses ``/``, a trailing ``/`` names a
    folder), so ``**`` deletes every file and a pattern matching nothing
    deletes nothing. A line that matches nothing makes no commit, warns
    the way upstream's ``create_commit`` does, and names the commit the
    revision already points at.
    """
    require_operands(inv, ["repo_id", "patterns"])
    require_token(inv, "repo-files delete")
    fl = FlagView(inv.flags)
    repo_id, *patterns = list(inv.texts)
    stderr = ""
    async with hub_for(
        inv, repo_id, repo_type_of(fl), fl.as_str("revision")
    ) as accessor:
        deletions = deletions_for(
            repo_files(await fetch_tree(accessor)), patterns
        )
        reply = await commit(
            accessor,
            deletions=deletions,
            message=fl.as_str("commit_message")
            or f"Delete files {' '.join(patterns)} with mirage",
            description=fl.as_str("commit_description") or "",
            create_pr=bool(fl.as_bool("create_pr")),
        )
        if reply is None:
            home = repo_url(inv.config.endpoint, accessor.repo_type, repo_id)
            url = f"{home}/commit/{await head_commit(accessor)}"
            stderr = EMPTY_COMMIT_WARNING
        else:
            reported = reply.get("commitUrl")
            url = reported if isinstance(reported, str) else ""

    return text_out(
        f"Files correctly deleted from repo. Commit: {url}.\n", stderr
    )
