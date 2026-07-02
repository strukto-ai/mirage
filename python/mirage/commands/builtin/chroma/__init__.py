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

from mirage.commands.builtin.chroma.find import find
from mirage.commands.builtin.chroma.search import search
from mirage.commands.builtin.chroma.sed import sed
from mirage.commands.builtin.generic_bind import (CommandIO,
                                                  make_generic_commands)
from mirage.core.chroma.read import read_bytes as _read
from mirage.core.chroma.read import read_stream as _read_stream
from mirage.core.chroma.readdir import readdir as _readdir
from mirage.core.chroma.stat import stat as _stat

# Chroma records are read through the generic factory; find normalises paths,
# search pushes down to the Chroma query API, and sed has no generic builder,
# so the three stay bespoke. Chroma is read-only, so the generic byte-mutation
# commands are intentionally absent (no write op wired).
_CHROMA_CMD_OPS = CommandIO(
    readdir=_readdir,
    read_bytes=_read,
    read_stream=_read_stream,
    stat=_stat,
    is_mounted=lambda a: True,
    local=False,
)

_CHROMA_OVERRIDES = {"find", "search", "sed"}

COMMANDS = [
    *make_generic_commands(
        "chroma",
        _CHROMA_CMD_OPS,
        overrides=_CHROMA_OVERRIDES,
    ),
    find,
    search,
    sed,
]
