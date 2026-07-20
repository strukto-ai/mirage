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

from dataclasses import replace

from mirage.commands.builtin.dify.cat import make_cat
from mirage.commands.builtin.dify.find import find
from mirage.commands.builtin.dify.io import IO as _IO
from mirage.commands.builtin.dify.search import search
from mirage.commands.builtin.generic_bind import (make_generic_commands,
                                                  with_read_cache)
from mirage.core.dify.stat import stat_light

_DIFY_OVERRIDES = {"cat", "find"}

_DIFY_CACHED_OPS = with_read_cache(_IO)
_DIFY_LIGHT_STAT_OPS = replace(_IO, stat=stat_light)

COMMANDS = [
    *make_generic_commands(
        "dify",
        _IO,
        overrides=_DIFY_OVERRIDES,
        ops_overrides={"ls": _DIFY_LIGHT_STAT_OPS},
    ),
    make_cat(_DIFY_CACHED_OPS),
    find,
    search,
]
