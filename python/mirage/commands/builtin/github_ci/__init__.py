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
from mirage.commands.builtin.github_ci.find import find
from mirage.commands.builtin.github_ci.grep import grep
from mirage.commands.builtin.github_ci.rg import rg
from mirage.commands.builtin.utils.wrap import stream_from_bytes
from mirage.core.github_ci.read import read as _read
from mirage.core.github_ci.readdir import readdir as _readdir
from mirage.core.github_ci.stat import stat as _stat

# GitHub CI logs/artifacts are read through the generic factory; find, grep
# and rg keep wrappers because they reject recursive search across runs (which
# would fetch every run's logs). GitHub CI is read-only, so the generic
# byte-mutation commands are intentionally absent (no write op wired). There is
# no native streaming read, so the stream is synthesized from the object read.
_GITHUB_CI_CMD_OPS = CommandIO(
    readdir=_readdir,
    read_bytes=_read,
    read_stream=partial(stream_from_bytes, _read),
    stat=_stat,
    is_mounted=lambda a: True,
    local=False,
)

_GITHUB_CI_OVERRIDES = {"find", "grep", "rg"}

COMMANDS = [
    *make_generic_commands(
        "github_ci",
        _GITHUB_CI_CMD_OPS,
        overrides=_GITHUB_CI_OVERRIDES,
    ),
    find,
    grep,
    rg,
]
