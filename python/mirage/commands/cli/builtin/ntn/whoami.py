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

from typing import Any

from mirage.accessor.notion import NotionAccessor
from mirage.commands.cli.builtin.ntn.util import notion_transport, pretty_json
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.core.notion.pages import get_self
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def whoami_row(me: dict[str, Any]) -> bytes:
    """Render `/users/me` as the tab-separated line the real CLI prints.

    Nine columns, pinned against the upstream binary: identity, then
    the workspace the token belongs to, then the bot's owner. A bot
    owned by the workspace repeats the workspace in the owner columns
    because that is literally who owns it; a bot owned by a user names
    that user, and their email is the fourth column, the same slot a
    person's own email occupies.

    Args:
        me (dict[str, Any]): the `/users/me` response.

    Returns:
        bytes: the rendered line with its trailing newline.
    """
    bot = me.get("bot") or {}
    owner = bot.get("owner") or {}
    user = owner.get("user") or {}
    workspace_id = bot.get("workspace_id") or ""
    workspace_name = bot.get("workspace_name") or ""
    # The last column is the owner's own kind, so a user owner reports
    # what that user is ("person"), not the "user" discriminator on the
    # envelope.
    if owner.get("type") == "user":
        email = (user.get("person") or {}).get("email") or ""
        owner_id = user.get("id") or ""
        owner_name = user.get("name") or ""
        owner_type = user.get("type") or ""
    else:
        email = (me.get("person") or {}).get("email") or ""
        owner_id = workspace_id
        owner_name = workspace_name
        owner_type = owner.get("type") or ""
    if not bot:
        owner_id = ""
        owner_name = ""
    columns = [
        me.get("id") or "",
        me.get("name") or "",
        me.get("type") or "",
        email,
        workspace_id,
        workspace_name,
        owner_id,
        owner_name,
        owner_type,
    ]
    return ("\t".join(columns) + "\n").encode()


async def whoami(
    accessor: NotionAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags)
    me = await get_self(notion_transport(accessor, ctx))
    if fl.as_bool("json"):
        return pretty_json(me), IOResult()
    return whoami_row(me), IOResult()
