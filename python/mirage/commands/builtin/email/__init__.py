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

from mirage.commands.builtin.email.basename import basename
from mirage.commands.builtin.email.cat import cat
from mirage.commands.builtin.email.dirname import dirname
from mirage.commands.builtin.email.email_forward import email_forward
from mirage.commands.builtin.email.email_read import email_read
from mirage.commands.builtin.email.email_reply import email_reply
from mirage.commands.builtin.email.email_reply_all import email_reply_all
from mirage.commands.builtin.email.email_send import email_send
from mirage.commands.builtin.email.email_triage import email_triage
from mirage.commands.builtin.email.find import find
from mirage.commands.builtin.email.grep import grep
from mirage.commands.builtin.email.head import head
from mirage.commands.builtin.email.jq import jq
from mirage.commands.builtin.email.ls import ls
from mirage.commands.builtin.email.nl import nl
from mirage.commands.builtin.email.realpath import realpath
from mirage.commands.builtin.email.rg import rg
from mirage.commands.builtin.email.stat import stat
from mirage.commands.builtin.email.tail import tail
from mirage.commands.builtin.email.tree import tree
from mirage.commands.builtin.email.wc import wc
from mirage.commands.builtin.filetype_factory import make_filetype_commands
from mirage.core.email.glob import resolve_glob as _ft_resolve_glob
from mirage.core.email.read import read as _ft_read

COMMANDS = [
    *make_filetype_commands(
        "email", _ft_resolve_glob, _ft_read, read_takes_index=True),
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
    stat,
    tail,
    tree,
    wc,
    email_send,
    email_reply,
    email_reply_all,
    email_forward,
    email_triage,
    email_read,
    grep,
]
