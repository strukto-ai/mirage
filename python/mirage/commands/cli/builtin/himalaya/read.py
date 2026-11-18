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
from mirage.commands.cli.builtin.himalaya.deliver import SEEN_FLAG
from mirage.commands.cli.builtin.himalaya.printer import notice
from mirage.commands.cli.builtin.himalaya.util import fetch_source
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.core.email.client import store_flags
from mirage.core.email.mime import render_mime
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def read(
    accessor: EmailAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags, ctx.spec)
    uid = texts[0]
    mailbox = fl.as_str("mailbox", "INBOX")
    raw = await fetch_source(accessor, mailbox, uid)
    if fl.as_bool("seen"):
        await store_flags(accessor, mailbox, [uid], [SEEN_FLAG], "add")
    if fl.as_bool("raw"):
        if fl.as_bool("json"):
            return notice(fl, raw.decode("utf-8", "replace")), IOResult()
        return raw, IOResult()
    answer = render_mime(raw, "json" if fl.as_bool("json") else "read")
    return answer, IOResult()
