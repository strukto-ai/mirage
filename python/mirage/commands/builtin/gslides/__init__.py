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
from mirage.commands.builtin.gslides.gws_slides_presentations_batchUpdate import \
    gws_slides_presentations_batchUpdate  # noqa: E501
from mirage.commands.builtin.gslides.gws_slides_presentations_create import \
    gws_slides_presentations_create  # noqa: E501
from mirage.commands.builtin.gslides.rm import rm
from mirage.commands.builtin.utils.wrap import stream_from_bytes
from mirage.core.gslides.read import read as _read
from mirage.core.gslides.readdir import readdir as _readdir
from mirage.core.gslides.stat import stat as _stat

# A presentation is written through the bespoke gws_slides_* API commands, not
# by writing raw bytes, so only the read ops feed the generic factory; the
# generic byte-mutation commands (cp/mv/tee/...) are intentionally absent.
_GSLIDES_CMD_OPS = CommandIO(
    readdir=_readdir,
    read_bytes=_read,
    read_stream=partial(stream_from_bytes, _read),
    stat=_stat,
    is_mounted=lambda a: True,
    local=False,
)

COMMANDS = [
    *make_generic_commands(
        "gslides",
        _GSLIDES_CMD_OPS,
    ),
    rm,
    gws_slides_presentations_create,
    gws_slides_presentations_batchUpdate,
]
