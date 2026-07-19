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
from mirage.commands.builtin.gdocs.gws_docs_write import gws_docs_write
from mirage.commands.builtin.gdrive._provision import \
    file_read_provision as _ft_provision
from mirage.commands.builtin.gdrive.du import du
from mirage.commands.builtin.gdrive.io import IO as _IO
from mirage.commands.builtin.generic_bind import make_generic_commands
from mirage.commands.builtin.gsheets.gws_sheets_append import gws_sheets_append
from mirage.commands.builtin.gsheets.gws_sheets_read import gws_sheets_read
from mirage.commands.builtin.gsheets.gws_sheets_write import gws_sheets_write
from mirage.commands.builtin.gws import (GWS_DOCS_API_COMMANDS,
                                         GWS_DRIVE_API_COMMANDS,
                                         GWS_SHEETS_API_COMMANDS,
                                         GWS_SLIDES_API_COMMANDS)
from mirage.core.gdrive.read import read as _read

# du keeps a wrapper because gdrive's du_all returns a flat list (du_multi
# contract) rather than the generic (list, total) tuple, matching onedrive.
_GDRIVE_OVERRIDES = {"du"}

COMMANDS = [
    *make_filetype_commands("gdrive",
                            _IO.resolve_glob,
                            _read,
                            read_takes_index=True,
                            provision=_ft_provision),
    *make_generic_commands(
        "gdrive",
        _IO,
        overrides=_GDRIVE_OVERRIDES,
    ),
    du,
    gws_docs_write,
    gws_sheets_read,
    gws_sheets_write,
    gws_sheets_append,
    *GWS_DRIVE_API_COMMANDS,
    *GWS_DOCS_API_COMMANDS,
    *GWS_SHEETS_API_COMMANDS,
    *GWS_SLIDES_API_COMMANDS,
]
