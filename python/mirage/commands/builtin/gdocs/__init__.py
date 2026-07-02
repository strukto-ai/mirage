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

from mirage.commands.builtin.gdocs.gws_docs_documents_batchUpdate import \
    gws_docs_documents_batchUpdate
from mirage.commands.builtin.gdocs.gws_docs_documents_create import \
    gws_docs_documents_create
from mirage.commands.builtin.gdocs.gws_docs_write import gws_docs_write
from mirage.commands.builtin.gdocs.rm import rm
from mirage.commands.builtin.generic_bind import (CommandIO,
                                                  make_generic_commands)
from mirage.commands.builtin.utils.wrap import stream_from_bytes
from mirage.core.gdocs.read import read as _read
from mirage.core.gdocs.readdir import readdir as _readdir
from mirage.core.gdocs.stat import stat as _stat

# A Google Doc is written through the bespoke gws_docs_* API commands, not by
# writing raw bytes, so only the read ops feed the generic factory; the
# generic byte-mutation commands (cp/mv/tee/...) are intentionally absent.
_GDOCS_CMD_OPS = CommandIO(
    readdir=_readdir,
    read_bytes=_read,
    read_stream=partial(stream_from_bytes, _read),
    stat=_stat,
    is_mounted=lambda a: True,
    local=False,
)

COMMANDS = [
    *make_generic_commands(
        "gdocs",
        _GDOCS_CMD_OPS,
    ),
    rm,
    gws_docs_documents_batchUpdate,
    gws_docs_documents_create,
    gws_docs_write,
]
