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

from mirage.commands.cli.builtin.hf.accessor import (hub_for, repo_type_of,
                                                     require_operands,
                                                     require_token, text_out)
from mirage.commands.cli.types import CLIInvocation
from mirage.commands.spec.types import FlagView
from mirage.core.hf_hub.commit import commit
from mirage.core.hf_hub.config import HfConfig
from mirage.core.hf_hub.constants import DEFAULT_COMMIT_MESSAGE
from mirage.io.types import ByteSource, IOResult


async def delete_cmd(
        inv: CLIInvocation[HfConfig]) -> tuple[ByteSource | None, IOResult]:
    """Delete files or folders from a repository, in one commit.

    A pattern ending in `/` is a folder, which the Hub deletes under its
    own key: sending one as a file deletion reports that no file by that
    name exists.
    """
    require_operands(inv, ["repo_id", "patterns"])
    require_token(inv, "repo-files delete")
    fl = FlagView(inv.flags)
    repo_id, *patterns = list(inv.texts)
    files = [p for p in patterns if not p.endswith("/")]
    folders = [p.rstrip("/") for p in patterns if p.endswith("/")]
    async with hub_for(inv, repo_id, repo_type_of(fl),
                       fl.as_str("revision")) as accessor:
        await commit(accessor,
                     deletions=files,
                     folders=folders,
                     message=fl.as_str("commit_message")
                     or DEFAULT_COMMIT_MESSAGE,
                     description=fl.as_str("commit_description") or "",
                     create_pr=bool(fl.as_bool("create_pr")))
        body = "".join(f"Deleted {p} from {repo_id}\n" for p in patterns)
        return text_out(body, mutated=True)
