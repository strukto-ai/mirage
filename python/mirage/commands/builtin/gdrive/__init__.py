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

from mirage.commands.builtin.filetype_factory import make_filetype_commands
from mirage.commands.builtin.gdocs.gws_docs_documents_batchUpdate import \
    gws_docs_documents_batchUpdate
from mirage.commands.builtin.gdocs.gws_docs_documents_create import \
    gws_docs_documents_create
from mirage.commands.builtin.gdocs.gws_docs_write import gws_docs_write
from mirage.commands.builtin.gdrive._provision import \
    file_read_provision as _ft_provision
from mirage.commands.builtin.gdrive.sed import sed
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
from mirage.commands.builtin.gslides.gws_slides_presentations_batchUpdate import \
    gws_slides_presentations_batchUpdate  # noqa: E501
from mirage.commands.builtin.gslides.gws_slides_presentations_create import \
    gws_slides_presentations_create  # noqa: E501
from mirage.commands.builtin.utils.wrap import stream_from_bytes
from mirage.core.gdrive.glob import resolve_glob as _ft_resolve_glob
from mirage.core.gdrive.read import read as _read
from mirage.core.gdrive.readdir import readdir as _readdir
from mirage.core.gdrive.stat import stat as _stat

# Drive holds real byte files (read via the generic factory) but is written
# only through the bespoke gws_* Workspace commands, so the generic
# byte-mutation commands (cp/mv/tee/...) are intentionally absent. sed has no
# generic builder and is kept as a wrapper. gdrive's native read_stream is a
# coroutine returning bytes-or-iterator (Workspace-aware), so the stream op is
# synthesized from the whole-file read instead.
_GDRIVE_CMD_OPS = CommandIO(
    readdir=_readdir,
    read_bytes=_read,
    read_stream=partial(stream_from_bytes, _read),
    stat=_stat,
    is_mounted=lambda a: True,
    local=False,
)

COMMANDS = [
    *make_filetype_commands("gdrive",
                            _ft_resolve_glob,
                            _read,
                            read_takes_index=True,
                            provision=_ft_provision),
    *make_generic_commands(
        "gdrive",
        _GDRIVE_CMD_OPS,
        provision_overrides={
            "grep": make_search_provision(_stat),
            "rg": make_search_provision(_stat),
            "ls": metadata_provision,
            "find": metadata_provision,
        },
    ),
    sed,
    gws_docs_documents_create,
    gws_docs_documents_batchUpdate,
    gws_docs_write,
    gws_slides_presentations_create,
    gws_slides_presentations_batchUpdate,
    gws_sheets_spreadsheets_create,
    gws_sheets_spreadsheets_batchUpdate,
    gws_sheets_read,
    gws_sheets_write,
    gws_sheets_append,
]
