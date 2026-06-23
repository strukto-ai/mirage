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
from mirage.commands.builtin.sharepoint._provision import \
    file_read_provision as _ft_provision
from mirage.commands.builtin.sharepoint.awk import awk
from mirage.commands.builtin.sharepoint.base64_cmd import base64_cmd
from mirage.commands.builtin.sharepoint.basename import basename
from mirage.commands.builtin.sharepoint.cat import cat
from mirage.commands.builtin.sharepoint.cmp import cmp_cmd
from mirage.commands.builtin.sharepoint.column import column
from mirage.commands.builtin.sharepoint.comm import comm
from mirage.commands.builtin.sharepoint.cp import cp
from mirage.commands.builtin.sharepoint.csplit import csplit
from mirage.commands.builtin.sharepoint.cut import cut
from mirage.commands.builtin.sharepoint.diff import diff
from mirage.commands.builtin.sharepoint.dirname import dirname
from mirage.commands.builtin.sharepoint.du import du
from mirage.commands.builtin.sharepoint.expand import expand
from mirage.commands.builtin.sharepoint.file import file
from mirage.commands.builtin.sharepoint.find import find
from mirage.commands.builtin.sharepoint.fmt import fmt
from mirage.commands.builtin.sharepoint.fold import fold
from mirage.commands.builtin.sharepoint.grep import grep
from mirage.commands.builtin.sharepoint.gunzip import gunzip
from mirage.commands.builtin.sharepoint.gzip import gzip
from mirage.commands.builtin.sharepoint.head import head
from mirage.commands.builtin.sharepoint.iconv import iconv
from mirage.commands.builtin.sharepoint.join import join
from mirage.commands.builtin.sharepoint.jq import jq
from mirage.commands.builtin.sharepoint.ln import ln
from mirage.commands.builtin.sharepoint.look import look
from mirage.commands.builtin.sharepoint.ls import ls
from mirage.commands.builtin.sharepoint.md5 import md5
from mirage.commands.builtin.sharepoint.mkdir import mkdir
from mirage.commands.builtin.sharepoint.mktemp import mktemp
from mirage.commands.builtin.sharepoint.mv import mv
from mirage.commands.builtin.sharepoint.nl import nl
from mirage.commands.builtin.sharepoint.paste import paste
from mirage.commands.builtin.sharepoint.patch import patch
from mirage.commands.builtin.sharepoint.readlink import readlink
from mirage.commands.builtin.sharepoint.realpath import realpath
from mirage.commands.builtin.sharepoint.rev import rev
from mirage.commands.builtin.sharepoint.rg import rg
from mirage.commands.builtin.sharepoint.rm import rm
from mirage.commands.builtin.sharepoint.sed import sed
from mirage.commands.builtin.sharepoint.sha256sum import sha256sum
from mirage.commands.builtin.sharepoint.shuf import shuf
from mirage.commands.builtin.sharepoint.sort import sort
from mirage.commands.builtin.sharepoint.split import split
from mirage.commands.builtin.sharepoint.stat import stat
from mirage.commands.builtin.sharepoint.strings import strings
from mirage.commands.builtin.sharepoint.tac import tac
from mirage.commands.builtin.sharepoint.tail import tail
from mirage.commands.builtin.sharepoint.tar import tar
from mirage.commands.builtin.sharepoint.tee import tee
from mirage.commands.builtin.sharepoint.touch import touch
from mirage.commands.builtin.sharepoint.tr import tr
from mirage.commands.builtin.sharepoint.tree import tree
from mirage.commands.builtin.sharepoint.tsort import tsort
from mirage.commands.builtin.sharepoint.unexpand import unexpand
from mirage.commands.builtin.sharepoint.uniq import uniq
from mirage.commands.builtin.sharepoint.unzip import unzip as unzip_cmd
from mirage.commands.builtin.sharepoint.wc import wc
from mirage.commands.builtin.sharepoint.xxd import xxd
from mirage.commands.builtin.sharepoint.zcat import zcat
from mirage.commands.builtin.sharepoint.zgrep import zgrep
from mirage.commands.builtin.sharepoint.zip_cmd import zip_cmd
from mirage.core.sharepoint.glob import resolve_glob as _ft_resolve_glob
from mirage.core.sharepoint.read import read_bytes as _ft_read

COMMANDS = [
    *make_filetype_commands(
        "sharepoint", _ft_resolve_glob, _ft_read, provision=_ft_provision),
    awk,
    base64_cmd,
    basename,
    cat,
    cmp_cmd,
    column,
    comm,
    cp,
    csplit,
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
    gunzip,
    gzip,
    head,
    iconv,
    join,
    jq,
    ln,
    look,
    ls,
    md5,
    mkdir,
    mktemp,
    mv,
    nl,
    paste,
    patch,
    readlink,
    realpath,
    rev,
    rg,
    rm,
    sed,
    sha256sum,
    shuf,
    sort,
    split,
    stat,
    strings,
    tac,
    tail,
    tar,
    tee,
    touch,
    tr,
    tree,
    tsort,
    unexpand,
    uniq,
    unzip_cmd,
    wc,
    xxd,
    zcat,
    zgrep,
    zip_cmd,
]
