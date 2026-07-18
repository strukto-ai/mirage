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
from mirage.commands.builtin.postgres.grep import grep
from mirage.commands.builtin.postgres.head import head
from mirage.commands.builtin.postgres.ops import OPS as _POSTGRES_CMD_OPS
from mirage.commands.builtin.postgres.rg import rg
from mirage.commands.builtin.postgres.tail import tail
from mirage.commands.builtin.postgres.wc import wc

_POSTGRES_OVERRIDES = {"grep", "head", "rg", "tail", "wc"}

COMMANDS = [
    *make_generic_commands(
        "postgres",
        _POSTGRES_CMD_OPS,
        overrides=_POSTGRES_OVERRIDES,
    ),
    grep,
    head,
    rg,
    tail,
    wc,
]
