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

from mirage.commands.builtin.dify.cat import make_cat
from mirage.commands.builtin.dify.find import find
from mirage.commands.builtin.dify.search import search
from mirage.commands.builtin.dify.sed import sed
from mirage.commands.builtin.generic_bind import (CommandIO,
                                                  make_generic_commands,
                                                  with_read_cache)
from mirage.core.dify.read import read_bytes as _read
from mirage.core.dify.read import read_stream as _read_stream
from mirage.core.dify.readdir import readdir as _readdir
from mirage.core.dify.stat import stat as _stat

# Dify knowledge-base documents are read through the generic factory. cat and
# find keep wrappers to avoid an extra document-detail API call per path: the
# generic cat eagerly stats the file and the generic find would call the full
# stat, while Dify's stat is a detail fetch (the wrappers use bespoke glob
# resolution / stat_light instead). search pushes down to the Dify retrieval
# API and sed has no generic builder. Dify is read-only, so the generic
# byte-mutation commands are intentionally absent (no write op wired).
_DIFY_CMD_OPS = CommandIO(
    readdir=_readdir,
    read_bytes=_read,
    read_stream=_read_stream,
    stat=_stat,
    is_mounted=lambda a: True,
    local=False,
)

_DIFY_OVERRIDES = {"cat", "find"}

_DIFY_CACHED_OPS = with_read_cache(_DIFY_CMD_OPS)

COMMANDS = [
    *make_generic_commands(
        "dify",
        _DIFY_CMD_OPS,
        overrides=_DIFY_OVERRIDES,
    ),
    make_cat(_DIFY_CACHED_OPS),
    find,
    search,
    sed,
]
