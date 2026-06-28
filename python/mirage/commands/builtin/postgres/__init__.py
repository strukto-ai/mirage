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
from mirage.commands.builtin.generic_bind.provision import metadata_provision
from mirage.commands.builtin.postgres.find import find
from mirage.commands.builtin.postgres.grep import grep
from mirage.commands.builtin.postgres.head import head
from mirage.commands.builtin.postgres.rg import rg
from mirage.commands.builtin.postgres.tail import tail
from mirage.commands.builtin.postgres.wc import wc
from mirage.commands.builtin.utils.wrap import stream_from_bytes
from mirage.core.postgres.read import read as _read
from mirage.core.postgres.readdir import readdir as _readdir
from mirage.core.postgres.stat import stat as _stat

# Postgres rows are read through the generic factory; find, grep and rg push
# down to SQL queries, and head, tail and wc push LIMIT/OFFSET/COUNT into the
# query so they stay bounded on large tables instead of reading the whole
# relation (kept bespoke). Postgres is read-only, so the generic byte-mutation
# commands are intentionally absent (no write op wired). There is no native
# streaming read, so the stream op is synthesized from the whole-row read.
_POSTGRES_CMD_OPS = CommandIO(
    readdir=_readdir,
    read_bytes=_read,
    read_stream=partial(stream_from_bytes, _read),
    stat=_stat,
    is_mounted=lambda a: True,
    local=False,
)

_POSTGRES_OVERRIDES = {"find", "grep", "head", "rg", "tail", "wc"}

COMMANDS = [
    *make_generic_commands(
        "postgres",
        _POSTGRES_CMD_OPS,
        overrides=_POSTGRES_OVERRIDES,
        provision_overrides={
            "ls": metadata_provision,
        },
    ),
    find,
    grep,
    head,
    rg,
    tail,
    wc,
]
