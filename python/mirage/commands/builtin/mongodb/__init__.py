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

from mirage.commands.builtin.generic_bind import make_generic_commands
from mirage.commands.builtin.mongodb.cat import cat
from mirage.commands.builtin.mongodb.grep import grep
from mirage.commands.builtin.mongodb.ops import OPS as _MONGODB_CMD_OPS
from mirage.commands.builtin.mongodb.rg import rg
from mirage.commands.builtin.mongodb.tail import tail
from mirage.commands.builtin.mongodb.wc import wc

_MONGODB_OVERRIDES = {"cat", "grep", "rg", "tail", "wc"}

COMMANDS = [
    *make_generic_commands(
        "mongodb",
        _MONGODB_CMD_OPS,
        overrides=_MONGODB_OVERRIDES,
    ),
    cat,
    grep,
    rg,
    tail,
    wc,
]
