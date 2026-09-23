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

from mirage.accessor.langfuse import LangfuseAccessor
from mirage.commands.builtin.generic_bind.search import make_search
from mirage.commands.builtin.grep_pushdown import pushdown_operand
from mirage.commands.builtin.langfuse.grep import SEARCHERS
from mirage.commands.builtin.langfuse.io import IO
from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.langfuse.scope import detect_scope
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

_search = make_search("rg",
                      detect_scope,
                      SEARCHERS,
                      IO,
                      qualify=pushdown_operand)


@command("rg", vfs="langfuse", spec=SPECS["rg"])
async def rg(accessor: LangfuseAccessor, paths: list[PathSpec],
             texts: list[str],
             opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    return await _search(accessor, paths, texts, opts)
