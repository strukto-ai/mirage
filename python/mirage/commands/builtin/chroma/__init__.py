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

from mirage.commands.builtin.chroma.find import find
from mirage.commands.builtin.chroma.io import IO as _IO
from mirage.commands.builtin.chroma.search import search
from mirage.commands.builtin.generic_bind import make_generic_commands

_CHROMA_OVERRIDES = {"find", "search"}

COMMANDS = [
    *make_generic_commands(
        "chroma",
        _IO,
        overrides=_CHROMA_OVERRIDES,
    ),
    find,
    search,
]
