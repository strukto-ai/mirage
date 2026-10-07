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

from mirage.commands.builtin.dify.search import search
from mirage.commands.builtin.generic_bind import (
    CommandIO,
    make_generic_commands,
)
from mirage.commands.builtin.slug_tree.find import make_find, reads_times
from mirage.core.dify.stat import stat, stat_light
from mirage.core.dify.tree import DIFY_TREE


def _light_ls(io: CommandIO) -> CommandIO:
    return replace(io, stat=stat_light)


COMMANDS = [
    *make_generic_commands(
        "dify",
        overrides={"find"},
        adapt={"ls": _light_ls},
    ),
    make_find("dify", DIFY_TREE, stat, stat_light, reads_times),
    search,
]
