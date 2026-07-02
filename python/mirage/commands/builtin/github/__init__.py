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
from mirage.commands.builtin.github.du import du
from mirage.commands.builtin.github.find import find
from mirage.commands.builtin.github.grep import grep
from mirage.commands.builtin.github.rg import rg
from mirage.commands.builtin.github.sed import sed
from mirage.commands.builtin.utils.wrap import stream_from_bytes
from mirage.core.github.read import read as _read
from mirage.core.github.readdir import readdir as _readdir
from mirage.core.github.stat import stat as _stat

# GitHub repo files are read through the generic factory; find keeps a wrapper
# for the "no tree loaded" guard and native tree-backed walk, grep and rg push
# down to the GitHub code-search API, du uses du_multi (flat-list contract) and
# sed has no generic builder. GitHub is read-only, so the generic byte-mutation
# commands are intentionally absent (no write op wired). There is no native
# streaming read, so the stream op is synthesized from the whole-blob read.
_GITHUB_CMD_OPS = CommandIO(
    readdir=_readdir,
    read_bytes=_read,
    read_stream=partial(stream_from_bytes, _read),
    stat=_stat,
    is_mounted=lambda a: True,
    local=False,
)

_GITHUB_OVERRIDES = {"du", "find", "grep", "rg", "sed"}

COMMANDS = [
    *make_generic_commands(
        "github",
        _GITHUB_CMD_OPS,
        overrides=_GITHUB_OVERRIDES,
    ),
    du,
    find,
    grep,
    rg,
    sed,
]
