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
from mirage.commands.builtin.gmail.grep import grep
from mirage.commands.builtin.gmail.gws_gmail_forward import gws_gmail_forward
from mirage.commands.builtin.gmail.gws_gmail_read import gws_gmail_read
from mirage.commands.builtin.gmail.gws_gmail_reply import gws_gmail_reply
from mirage.commands.builtin.gmail.gws_gmail_reply_all import \
    gws_gmail_reply_all
from mirage.commands.builtin.gmail.gws_gmail_send import gws_gmail_send
from mirage.commands.builtin.gmail.gws_gmail_triage import gws_gmail_triage
from mirage.commands.builtin.gmail.io import IO as _IO
from mirage.commands.builtin.gmail.rg import rg
from mirage.commands.builtin.gws import GWS_GMAIL_API_COMMANDS
from mirage.core.gmail.read import read as _read

COMMANDS = [
    *make_filetype_commands(
        "gmail", _IO.resolve_glob, _read, read_takes_index=True),
    *make_generic_commands(
        "gmail",
        _IO,
        overrides={"grep", "rg"},
    ),
    grep,
    rg,
    gws_gmail_send,
    gws_gmail_reply,
    gws_gmail_reply_all,
    gws_gmail_forward,
    gws_gmail_triage,
    gws_gmail_read,
    *GWS_GMAIL_API_COMMANDS,
]
