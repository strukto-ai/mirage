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

from mirage.commands.builtin.filetype_factory import make_filetype_commands
from mirage.commands.builtin.generic_bind import make_generic_commands
from mirage.commands.builtin.sharepoint._provision import \
    file_read_provision as _ft_provision
from mirage.commands.builtin.sharepoint.du import du
from mirage.commands.builtin.sharepoint.ops import OPS as _SHAREPOINT_CMD_OPS
from mirage.core.sharepoint.read import read_bytes as _read

_SHAREPOINT_OVERRIDES = {"du"}

COMMANDS = [
    *make_filetype_commands("sharepoint",
                            _SHAREPOINT_CMD_OPS.resolve_glob,
                            _read,
                            provision=_ft_provision),
    *make_generic_commands(
        "sharepoint",
        _SHAREPOINT_CMD_OPS,
        overrides=_SHAREPOINT_OVERRIDES,
    ),
    du,
]
