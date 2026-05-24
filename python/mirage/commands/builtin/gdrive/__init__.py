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
from mirage.commands.builtin.gdocs.gws_docs_documents_batchUpdate import \
    gws_docs_documents_batchUpdate
from mirage.commands.builtin.gdocs.gws_docs_documents_create import \
    gws_docs_documents_create
from mirage.commands.builtin.gdocs.gws_docs_write import gws_docs_write
from mirage.commands.builtin.gdrive._provision import \
    file_read_provision as _ft_provision
from mirage.commands.builtin.gdrive.awk import awk
from mirage.commands.builtin.gdrive.base64_cmd import base64_cmd
from mirage.commands.builtin.gdrive.basename import basename
from mirage.commands.builtin.gdrive.cat import cat
from mirage.commands.builtin.gdrive.cmp import cmp_cmd
from mirage.commands.builtin.gdrive.column import column
from mirage.commands.builtin.gdrive.comm import comm
from mirage.commands.builtin.gdrive.cut import cut
from mirage.commands.builtin.gdrive.diff import diff
from mirage.commands.builtin.gdrive.dirname import dirname
from mirage.commands.builtin.gdrive.du import du
from mirage.commands.builtin.gdrive.expand import expand
from mirage.commands.builtin.gdrive.file import file
from mirage.commands.builtin.gdrive.find import find
from mirage.commands.builtin.gdrive.fmt import fmt
from mirage.commands.builtin.gdrive.fold import fold
from mirage.commands.builtin.gdrive.grep import grep
from mirage.commands.builtin.gdrive.head import head
from mirage.commands.builtin.gdrive.join import join
from mirage.commands.builtin.gdrive.jq import jq
from mirage.commands.builtin.gdrive.look import look
from mirage.commands.builtin.gdrive.ls import ls
from mirage.commands.builtin.gdrive.md5 import md5
from mirage.commands.builtin.gdrive.nl import nl
from mirage.commands.builtin.gdrive.paste import paste
from mirage.commands.builtin.gdrive.readlink import readlink
from mirage.commands.builtin.gdrive.realpath import realpath
from mirage.commands.builtin.gdrive.rev import rev
from mirage.commands.builtin.gdrive.rg import rg
from mirage.commands.builtin.gdrive.sed import sed
from mirage.commands.builtin.gdrive.sha256sum import sha256sum
from mirage.commands.builtin.gdrive.shuf import shuf
from mirage.commands.builtin.gdrive.sort import sort
from mirage.commands.builtin.gdrive.stat import stat
from mirage.commands.builtin.gdrive.strings import strings
from mirage.commands.builtin.gdrive.tac import tac
from mirage.commands.builtin.gdrive.tail import tail
from mirage.commands.builtin.gdrive.tr import tr
from mirage.commands.builtin.gdrive.tree import tree
from mirage.commands.builtin.gdrive.tsort import tsort
from mirage.commands.builtin.gdrive.unexpand import unexpand
from mirage.commands.builtin.gdrive.uniq import uniq
from mirage.commands.builtin.gdrive.wc import wc
from mirage.commands.builtin.gdrive.xxd import xxd
from mirage.commands.builtin.gdrive.zcat import zcat
from mirage.commands.builtin.gdrive.zgrep import zgrep
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
from mirage.core.gdrive.glob import resolve_glob as _ft_resolve_glob
from mirage.core.gdrive.read import read as _ft_read

COMMANDS = [
    *make_filetype_commands("gdrive",
                            _ft_resolve_glob,
                            _ft_read,
                            read_takes_index=True,
                            provision=_ft_provision),
    awk,
    base64_cmd,
    basename,
    cat,
    cmp_cmd,
    column,
    comm,
    cut,
    diff,
    dirname,
    du,
    expand,
    file,
    find,
    fmt,
    fold,
    grep,
    head,
    join,
    jq,
    look,
    ls,
    md5,
    nl,
    paste,
    readlink,
    realpath,
    rev,
    rg,
    sed,
    sha256sum,
    shuf,
    sort,
    stat,
    strings,
    tac,
    tail,
    tr,
    tree,
    tsort,
    unexpand,
    uniq,
    wc,
    xxd,
    zcat,
    zgrep,
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
