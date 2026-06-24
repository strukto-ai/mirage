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

from functools import partial

from mirage.commands.builtin.generic_bind import (CommandIO,
                                                  make_generic_commands)
from mirage.commands.builtin.generic_bind.provision import (
    make_search_provision, metadata_provision)
from mirage.commands.builtin.lancedb.find import find
from mirage.commands.builtin.lancedb.search import search
from mirage.commands.builtin.utils.wrap import stream_from_bytes
from mirage.core.lancedb.read import read as _read
from mirage.core.lancedb.readdir import readdir as _readdir
from mirage.core.lancedb.stat import stat as _stat

# LanceDB rows are read through the generic factory; find and search push down
# to the LanceDB query API (kept bespoke). LanceDB is read-only, so the generic
# byte-mutation commands are intentionally absent (no write op wired). There is
# no native streaming read, so the stream op is synthesized from the whole-row
# read.
_LANCEDB_CMD_OPS = CommandIO(
    readdir=_readdir,
    read_bytes=_read,
    read_stream=partial(stream_from_bytes, _read),
    stat=_stat,
    is_mounted=lambda a: True,
    local=False,
)

_LANCEDB_OVERRIDES = {"find", "search"}

COMMANDS = [
    *make_generic_commands(
        "lancedb",
        _LANCEDB_CMD_OPS,
        overrides=_LANCEDB_OVERRIDES,
        provision_overrides={
            "grep": make_search_provision(_stat),
            "rg": make_search_provision(_stat),
            "ls": metadata_provision,
        },
    ),
    find,
    search,
]
