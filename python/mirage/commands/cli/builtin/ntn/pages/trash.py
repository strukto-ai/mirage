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

from mirage.commands.cli.builtin.ntn.util import first_text, notion_config
from mirage.commands.cli.types import CLIInvocation
from mirage.commands.spec.types import FlagView
from mirage.core.notion.config import NotionConfig
from mirage.core.notion.pages import update_page
from mirage.io.types import ByteSource, IOResult

NEEDS_YES = ("error: Cannot confirm in a non-interactive environment.\n"
             "  hint: Use --yes to skip the confirmation prompt.\n")


async def trash(
        inv: CLIInvocation[NotionConfig]
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    page_id = first_text(inv.texts, "page id")
    # A mirage session has no terminal, so this is the branch the
    # upstream CLI takes when it cannot prompt: refuse and say how.
    # stderr is plain bytes, never a stream: the recorded execution node
    # materializes it, and a one-shot generator read there would leave
    # the shell nothing to print.
    if not fl.as_bool("yes"):
        return None, IOResult(stderr=NEEDS_YES.encode(), exit_code=1)
    await update_page(notion_config(inv), page_id, {"in_trash": True})
    return None, IOResult(stderr="✔ Page trashed\n".encode())
