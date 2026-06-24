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
from mirage.commands.builtin.generic_bind.provision import (
    make_search_provision, metadata_provision)
from mirage.commands.builtin.gsheets.gws_sheets_append import gws_sheets_append
from mirage.commands.builtin.gsheets.gws_sheets_read import gws_sheets_read
from mirage.commands.builtin.gsheets.gws_sheets_spreadsheets_batchUpdate import \
    gws_sheets_spreadsheets_batchUpdate  # noqa: E501
from mirage.commands.builtin.gsheets.gws_sheets_spreadsheets_create import \
    gws_sheets_spreadsheets_create  # noqa: E501
from mirage.commands.builtin.gsheets.gws_sheets_write import gws_sheets_write
from mirage.commands.builtin.gsheets.rm import rm
from mirage.commands.builtin.utils.wrap import stream_from_bytes
from mirage.core.gsheets.read import read as _read
from mirage.core.gsheets.readdir import readdir as _readdir
from mirage.core.gsheets.stat import stat as _stat

# A spreadsheet is written through the bespoke gws_sheets_* API commands, not
# by writing raw bytes, so only the read ops feed the generic factory; the
# generic byte-mutation commands (cp/mv/tee/...) are intentionally absent.
_GSHEETS_CMD_OPS = CommandIO(
    readdir=_readdir,
    read_bytes=_read,
    read_stream=partial(stream_from_bytes, _read),
    stat=_stat,
    is_mounted=lambda a: True,
    local=False,
)

COMMANDS = [
    *make_generic_commands(
        "gsheets",
        _GSHEETS_CMD_OPS,
        provision_overrides={
            "grep": make_search_provision(_stat),
            "rg": make_search_provision(_stat),
            "ls": metadata_provision,
            "find": metadata_provision,
        },
    ),
    rm,
    gws_sheets_append,
    gws_sheets_read,
    gws_sheets_spreadsheets_batchUpdate,
    gws_sheets_spreadsheets_create,
    gws_sheets_write,
]
