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

from mirage.accessor.postgres import PostgresAccessor
from mirage.commands.builtin.generic_bind.search import make_search
from mirage.commands.builtin.grep_pushdown import literal_pushdown_operand
from mirage.commands.builtin.postgres.io import IO
from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.postgres.scope import detect_scope
from mirage.core.postgres.search import SEARCHERS
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

# The push-down is a literal-substring search that prints each matching
# row as a whole line; literal_pushdown_operand defers a real regex, a
# multi-operand line and every shaping flag to the generic scan.
_search = make_search("grep",
                      detect_scope,
                      SEARCHERS,
                      IO,
                      qualify=literal_pushdown_operand,
                      guard=True)


@command("grep", vfs="postgres", spec=SPECS["grep"])
async def grep(accessor: PostgresAccessor, paths: list[PathSpec],
               texts: list[str],
               opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    return await _search(accessor, paths, texts, opts)
