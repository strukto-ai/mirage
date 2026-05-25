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
from mirage.commands.builtin.gmail.basename import basename
from mirage.commands.builtin.gmail.cat import cat
from mirage.commands.builtin.gmail.dirname import dirname
from mirage.commands.builtin.gmail.find import find
from mirage.commands.builtin.gmail.grep import grep
from mirage.commands.builtin.gmail.gws_gmail_forward import gws_gmail_forward
from mirage.commands.builtin.gmail.gws_gmail_read import gws_gmail_read
from mirage.commands.builtin.gmail.gws_gmail_reply import gws_gmail_reply
from mirage.commands.builtin.gmail.gws_gmail_reply_all import \
    gws_gmail_reply_all
from mirage.commands.builtin.gmail.gws_gmail_send import gws_gmail_send
from mirage.commands.builtin.gmail.gws_gmail_triage import gws_gmail_triage
from mirage.commands.builtin.gmail.head import head
from mirage.commands.builtin.gmail.jq import jq
from mirage.commands.builtin.gmail.ls import ls
from mirage.commands.builtin.gmail.nl import nl
from mirage.commands.builtin.gmail.realpath import realpath
from mirage.commands.builtin.gmail.rg import rg
from mirage.commands.builtin.gmail.rm import rm
from mirage.commands.builtin.gmail.stat import stat
from mirage.commands.builtin.gmail.tail import tail
from mirage.commands.builtin.gmail.tree import tree
from mirage.commands.builtin.gmail.wc import wc
from mirage.core.gmail.glob import resolve_glob as _ft_resolve_glob
from mirage.core.gmail.read import read as _ft_read

COMMANDS = [
    *make_filetype_commands(
        "gmail", _ft_resolve_glob, _ft_read, read_takes_index=True),
    basename,
    cat,
    dirname,
    find,
    head,
    jq,
    ls,
    nl,
    realpath,
    rg,
    rm,
    stat,
    tail,
    tree,
    wc,
    gws_gmail_send,
    gws_gmail_reply,
    gws_gmail_reply_all,
    gws_gmail_forward,
    gws_gmail_triage,
    gws_gmail_read,
    grep,
]
