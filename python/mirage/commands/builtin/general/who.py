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
from mirage.accessor.base import Accessor
from mirage.commands.config import Context, command
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.usage import extra_operand_error
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

COUNT = b"\n# users=0\n"
HEADING = b"NAME     LINE         TIME         COMMENT\n"


@command("who", vfs=None, spec=SPECS["who"])
async def who(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    """Nobody logs in to a workspace and it has no boot record, so only
    ``-q`` and ``-H`` print anything.
    """
    if len(texts) > 2:
        raise extra_operand_error("who", texts[2])
    fl = FlagView(ctx.flags, spec=SPECS["who"])
    if fl.as_bool("count"):
        return COUNT, IOResult()
    return HEADING if fl.as_bool("heading") else None, IOResult()
