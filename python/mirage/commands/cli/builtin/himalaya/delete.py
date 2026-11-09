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

from mirage.accessor.email import EmailAccessor
from mirage.commands.cli.builtin.himalaya.deliver import tagged_folder
from mirage.commands.cli.builtin.himalaya.printer import rendered
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.core.email.client import delete_messages, move_messages
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

TRASH_ATTRIBUTE = "\\trash"
DEFAULT_TRASH_FOLDER = "Trash"


async def message_delete(
    accessor: EmailAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags, ctx.spec)
    mailbox = fl.as_str("mailbox", "INBOX")
    trash = accessor.config.trash_folder or await tagged_folder(
        accessor, TRASH_ATTRIBUTE, DEFAULT_TRASH_FOLDER
    )
    if mailbox != trash:
        count = await move_messages(accessor, mailbox, trash, texts)
        action = "moved-to-trash"
        text = f"Successfully moved {count} message(s) to the trash"
    else:
        count = len(texts)
        removed = await delete_messages(accessor, mailbox, texts)
        if removed:
            action = "deleted"
            text = f"Successfully deleted {count} message(s) from the trash"
        else:
            action = "flagged"
            text = (
                f"Flagged {count} message(s) as deleted; "
                "run an expunge on the trash to remove them"
            )
    return rendered(fl, {"action": action, "count": count}, text), IOResult()
