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

from mirage.commands.builtin.general.arch import arch
from mirage.commands.builtin.general.bc import bc
from mirage.commands.builtin.general.colrm import colrm
from mirage.commands.builtin.general.curl import curl
from mirage.commands.builtin.general.date import date
from mirage.commands.builtin.general.envsubst import envsubst
from mirage.commands.builtin.general.expr import expr
from mirage.commands.builtin.general.getconf import getconf
from mirage.commands.builtin.general.groups import groups
from mirage.commands.builtin.general.hostid import hostid
from mirage.commands.builtin.general.hostname import hostname
from mirage.commands.builtin.general.id import id_cmd
from mirage.commands.builtin.general.js import js, node
from mirage.commands.builtin.general.link import link
from mirage.commands.builtin.general.logname import logname
from mirage.commands.builtin.general.nproc import nproc
from mirage.commands.builtin.general.pathchk import pathchk
from mirage.commands.builtin.general.python import python3, python_cmd
from mirage.commands.builtin.general.seq import seq
from mirage.commands.builtin.general.sync import sync
from mirage.commands.builtin.general.tty import tty
from mirage.commands.builtin.general.uname import uname
from mirage.commands.builtin.general.users import users
from mirage.commands.builtin.general.wget import wget
from mirage.commands.builtin.general.who import who
from mirage.commands.builtin.general.yes import yes

_FNS = [
    arch,
    bc,
    colrm,
    curl,
    date,
    envsubst,
    expr,
    getconf,
    groups,
    hostid,
    hostname,
    id_cmd,
    js,
    link,
    logname,
    node,
    nproc,
    pathchk,
    python3,
    python_cmd,
    seq,
    sync,
    tty,
    uname,
    users,
    wget,
    who,
    yes,
]

COMMANDS = []
for _fn in _FNS:
    COMMANDS.extend(_fn._registered_commands)
