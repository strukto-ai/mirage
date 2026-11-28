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

# `tvly auth` keeps tvly 1.0.2's shape (src/commands/auth.ts; MIT, see
# licenses/third_party/tavily-cli.txt). A workspace has no environment
# variable or config file the key came from: the install carries it, so
# that is the source it names, and the key itself is never shown, not
# even in part.

from mirage.accessor.tavily import TavilyAccessor
from mirage.commands.cli.builtin.tvly.failure import NO_KEY
from mirage.commands.cli.builtin.tvly.output import Streams
from mirage.commands.cli.builtin.tvly.render import json_text
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import JsonValue, PathSpec

METHOD = "api_key"
SOURCE = "the tvly install's api_key"


async def auth(
    accessor: TavilyAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    """Say whether the install carries a key.

    Args:
        accessor (TavilyAccessor): the install's account.
        paths (list[PathSpec]): unused.
        texts (list[str]): unused.
        ctx (Context): the invocation context.
    """
    keyed = accessor.config.api_key is not None
    streams = Streams()
    if FlagView(ctx.flags, ctx.spec).as_bool("json"):
        payload: dict[str, JsonValue] = {
            "authenticated": keyed,
            "method": METHOD if keyed else None,
            "source": SOURCE if keyed else None,
        }
        streams.out(json_text(payload, False))
        return streams.result()
    streams.out()
    if keyed:
        streams.out(f"  > Authenticated via {SOURCE}")
        streams.out("    Key: ***")
    else:
        streams.out("  > Not authenticated")
        streams.out()
        streams.out(NO_KEY)
    streams.out()
    return streams.result()
