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

from mirage.commands.builtin.dropbox.grep import grep
from mirage.commands.builtin.dropbox.io import IO as _IO
from mirage.commands.builtin.dropbox.rg import rg
from mirage.commands.builtin.filetype_factory import make_filetype_commands
from mirage.commands.builtin.generic_bind import (make_file_read_provision,
                                                  make_generic_commands)
from mirage.core.dropbox.read import read as _read
from mirage.core.dropbox.stat import stat as _stat

_DROPBOX_OVERRIDES = {"grep", "rg"}

COMMANDS = [
    *make_filetype_commands("dropbox",
                            _IO.resolve_glob,
                            _read,
                            read_takes_index=True,
                            provision=make_file_read_provision(_stat)),
    *make_generic_commands("dropbox", _IO, overrides=_DROPBOX_OVERRIDES),
    grep,
    rg,
]
