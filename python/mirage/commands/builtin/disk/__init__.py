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

from mirage.commands.builtin.disk.awk import awk
from mirage.commands.builtin.disk.base64_cmd import base64_cmd
from mirage.commands.builtin.disk.basename import basename
from mirage.commands.builtin.disk.cat import cat
from mirage.commands.builtin.disk.cmp import cmp_cmd
from mirage.commands.builtin.disk.column import column
from mirage.commands.builtin.disk.comm import comm
from mirage.commands.builtin.disk.cp import cp
from mirage.commands.builtin.disk.csplit import csplit
from mirage.commands.builtin.disk.cut import cut
from mirage.commands.builtin.disk.diff import diff
from mirage.commands.builtin.disk.dirname import dirname
from mirage.commands.builtin.disk.du import du
from mirage.commands.builtin.disk.expand import expand
from mirage.commands.builtin.disk.file import file
from mirage.commands.builtin.disk.find import find
from mirage.commands.builtin.disk.fmt import fmt
from mirage.commands.builtin.disk.fold import fold
from mirage.commands.builtin.disk.grep import grep
from mirage.commands.builtin.disk.gunzip import gunzip
from mirage.commands.builtin.disk.gzip import gzip
from mirage.commands.builtin.disk.head import head
from mirage.commands.builtin.disk.iconv import iconv
from mirage.commands.builtin.disk.join import join
from mirage.commands.builtin.disk.jq import jq
from mirage.commands.builtin.disk.ln import ln
from mirage.commands.builtin.disk.look import look
from mirage.commands.builtin.disk.ls import ls
from mirage.commands.builtin.disk.md5 import md5
from mirage.commands.builtin.disk.mkdir import mkdir
from mirage.commands.builtin.disk.mktemp import mktemp
from mirage.commands.builtin.disk.mv import mv
from mirage.commands.builtin.disk.nl import nl
from mirage.commands.builtin.disk.paste import paste
from mirage.commands.builtin.disk.patch import patch
from mirage.commands.builtin.disk.readlink import readlink
from mirage.commands.builtin.disk.realpath import realpath
from mirage.commands.builtin.disk.rev import rev
from mirage.commands.builtin.disk.rg import rg
from mirage.commands.builtin.disk.rm import rm
from mirage.commands.builtin.disk.sed import sed
from mirage.commands.builtin.disk.sha256sum import sha256sum
from mirage.commands.builtin.disk.shuf import shuf
from mirage.commands.builtin.disk.sort import sort
from mirage.commands.builtin.disk.split import split
from mirage.commands.builtin.disk.stat import stat
from mirage.commands.builtin.disk.strings import strings
from mirage.commands.builtin.disk.tac import tac
from mirage.commands.builtin.disk.tail import tail
from mirage.commands.builtin.disk.tar import tar
from mirage.commands.builtin.disk.tee import tee
from mirage.commands.builtin.disk.touch import touch
from mirage.commands.builtin.disk.tr import tr
from mirage.commands.builtin.disk.tree import tree
from mirage.commands.builtin.disk.tsort import tsort
from mirage.commands.builtin.disk.unexpand import unexpand
from mirage.commands.builtin.disk.uniq import uniq
from mirage.commands.builtin.disk.unzip import unzip as unzip_cmd
from mirage.commands.builtin.disk.wc import wc
from mirage.commands.builtin.disk.xxd import xxd
from mirage.commands.builtin.disk.zcat import zcat
from mirage.commands.builtin.disk.zgrep import zgrep
from mirage.commands.builtin.disk.zip_cmd import zip_cmd
from mirage.commands.builtin.filetype_factory import make_filetype_commands
from mirage.core.disk.glob import resolve_glob as _ft_resolve_glob
from mirage.core.disk.read import read_bytes as _ft_read

COMMANDS = [
    *make_filetype_commands("disk", _ft_resolve_glob, _ft_read),
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
