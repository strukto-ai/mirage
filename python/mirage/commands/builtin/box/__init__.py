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

from mirage.commands.builtin.box.du import du
from mirage.commands.builtin.box.grep import grep
from mirage.commands.builtin.box.io import IO as _IO
from mirage.commands.builtin.box.rg import rg
from mirage.commands.builtin.filetype_factory import make_filetype_commands
from mirage.commands.builtin.generic_bind import (make_file_read_provision,
                                                  make_generic_commands)
from mirage.core.box.read import read as _read
from mirage.core.box.stat import stat as _stat

_BOX_OVERRIDES = {"du", "grep", "rg"}

COMMANDS = [
    *make_filetype_commands("box",
                            _IO.resolve_glob,
                            _read,
                            read_takes_index=True,
                            provision=make_file_read_provision(_stat)),
    *make_generic_commands(
        "box",
        _IO,
        overrides=_BOX_OVERRIDES,
    ),
    du,
    grep,
    rg,
]
