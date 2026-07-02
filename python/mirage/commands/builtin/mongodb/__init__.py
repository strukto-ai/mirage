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

from mirage.commands.builtin.generic_bind import (CommandIO,
                                                  make_generic_commands)
from mirage.commands.builtin.mongodb.cat import cat
from mirage.commands.builtin.mongodb.find import find
from mirage.commands.builtin.mongodb.grep import grep
from mirage.commands.builtin.mongodb.rg import rg
from mirage.commands.builtin.mongodb.tail import tail
from mirage.commands.builtin.mongodb.wc import wc
from mirage.core.mongodb.read import read as _read
from mirage.core.mongodb.readdir import readdir as _readdir
from mirage.core.mongodb.stat import stat as _stat
from mirage.core.mongodb.stream import read_stream as _read_stream

# Mongo documents are read through the generic factory. find, grep and rg push
# down to MongoDB queries, tail follows via change streams (tail -f), wc -l
# counts via server-side count_documents instead of reading every document, and
# cat dispatches by path (native document streaming vs rendered .json metadata,
# which the document-only read_stream cannot serve), so they stay bespoke.
# Mongo is read-only, so the generic byte-mutation commands are intentionally
# absent (no write op wired).
_MONGODB_CMD_OPS = CommandIO(
    readdir=_readdir,
    read_bytes=_read,
    read_stream=_read_stream,
    stat=_stat,
    is_mounted=lambda a: True,
    local=False,
)

_MONGODB_OVERRIDES = {"cat", "find", "grep", "rg", "tail", "wc"}

COMMANDS = [
    *make_generic_commands(
        "mongodb",
        _MONGODB_CMD_OPS,
        overrides=_MONGODB_OVERRIDES,
    ),
    cat,
    find,
    grep,
    rg,
    tail,
    wc,
]
