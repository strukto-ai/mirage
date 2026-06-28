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
from mirage.commands.builtin.generic_bind import (CommandIO,
                                                  make_generic_commands)
from mirage.commands.builtin.generic_bind.provision import metadata_provision
from mirage.commands.builtin.gmail.grep import grep
from mirage.commands.builtin.gmail.gws_gmail_delete import gws_gmail_delete
from mirage.commands.builtin.gmail.gws_gmail_forward import gws_gmail_forward
from mirage.commands.builtin.gmail.gws_gmail_read import gws_gmail_read
from mirage.commands.builtin.gmail.gws_gmail_reply import gws_gmail_reply
from mirage.commands.builtin.gmail.gws_gmail_reply_all import \
    gws_gmail_reply_all
from mirage.commands.builtin.gmail.gws_gmail_send import gws_gmail_send
from mirage.commands.builtin.gmail.gws_gmail_triage import gws_gmail_triage
from mirage.commands.builtin.gmail.rg import rg
from mirage.commands.builtin.utils.wrap import stream_from_bytes
from mirage.core.gmail.glob import resolve_glob as _ft_resolve_glob
from mirage.core.gmail.read import read as _read
from mirage.core.gmail.readdir import readdir as _readdir
from mirage.core.gmail.stat import stat as _stat

# Mail is read through the generic factory; grep/rg push down to the Gmail
# search API (kept bespoke) and writes go through the gws_gmail_* commands, so
# the generic byte-mutation commands are intentionally absent.
_GMAIL_CMD_OPS = CommandIO(
    readdir=_readdir,
    read_bytes=_read,
    read_stream=partial(stream_from_bytes, _read),
    stat=_stat,
    is_mounted=lambda a: True,
    local=False,
)

COMMANDS = [
    *make_filetype_commands(
        "gmail", _ft_resolve_glob, _read, read_takes_index=True),
    *make_generic_commands(
        "gmail",
        _GMAIL_CMD_OPS,
        overrides={"grep", "rg"},
        provision_overrides={
            "ls": metadata_provision,
            "find": metadata_provision,
        },
    ),
    grep,
    rg,
    gws_gmail_send,
    gws_gmail_reply,
    gws_gmail_reply_all,
    gws_gmail_forward,
    gws_gmail_triage,
    gws_gmail_read,
    gws_gmail_delete,
]
