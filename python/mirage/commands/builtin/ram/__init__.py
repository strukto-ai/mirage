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
from mirage.commands.builtin.ram.awk import awk
from mirage.commands.builtin.ram.base64_cmd import base64_cmd
from mirage.commands.builtin.ram.basename import basename
from mirage.commands.builtin.ram.cat import cat
from mirage.commands.builtin.ram.cmp import cmp_cmd
from mirage.commands.builtin.ram.column import column
from mirage.commands.builtin.ram.comm import comm
from mirage.commands.builtin.ram.cp import cp
from mirage.commands.builtin.ram.csplit import csplit
from mirage.commands.builtin.ram.cut import cut
from mirage.commands.builtin.ram.diff import diff
from mirage.commands.builtin.ram.dirname import dirname
from mirage.commands.builtin.ram.du import du
from mirage.commands.builtin.ram.expand import expand
from mirage.commands.builtin.ram.file import file
from mirage.commands.builtin.ram.find import find
from mirage.commands.builtin.ram.fmt import fmt
from mirage.commands.builtin.ram.fold import fold
from mirage.commands.builtin.ram.grep import grep
from mirage.commands.builtin.ram.gunzip import gunzip
from mirage.commands.builtin.ram.gzip import gzip
from mirage.commands.builtin.ram.head import head
from mirage.commands.builtin.ram.iconv import iconv
from mirage.commands.builtin.ram.join import join
from mirage.commands.builtin.ram.jq import jq
from mirage.commands.builtin.ram.ln import ln
from mirage.commands.builtin.ram.look import look
from mirage.commands.builtin.ram.ls import ls
from mirage.commands.builtin.ram.md5 import md5
from mirage.commands.builtin.ram.mkdir import mkdir
from mirage.commands.builtin.ram.mktemp import mktemp
from mirage.commands.builtin.ram.mv import mv
from mirage.commands.builtin.ram.nl import nl
from mirage.commands.builtin.ram.paste import paste
from mirage.commands.builtin.ram.patch import patch
from mirage.commands.builtin.ram.readlink import readlink
from mirage.commands.builtin.ram.realpath import realpath
from mirage.commands.builtin.ram.rev import rev
from mirage.commands.builtin.ram.rg import rg
from mirage.commands.builtin.ram.rm import rm
from mirage.commands.builtin.ram.sed import sed
from mirage.commands.builtin.ram.sha256sum import sha256sum
from mirage.commands.builtin.ram.shuf import shuf
from mirage.commands.builtin.ram.sort import sort
from mirage.commands.builtin.ram.split import split
from mirage.commands.builtin.ram.stat import stat
from mirage.commands.builtin.ram.strings import strings
from mirage.commands.builtin.ram.tac import tac
from mirage.commands.builtin.ram.tail import tail
from mirage.commands.builtin.ram.tar import tar
from mirage.commands.builtin.ram.tee import tee
from mirage.commands.builtin.ram.touch import touch
from mirage.commands.builtin.ram.tr import tr
from mirage.commands.builtin.ram.tree import tree
from mirage.commands.builtin.ram.tsort import tsort
from mirage.commands.builtin.ram.unexpand import unexpand
from mirage.commands.builtin.ram.uniq import uniq
from mirage.commands.builtin.ram.unzip import unzip as unzip_cmd
from mirage.commands.builtin.ram.wc import wc
from mirage.commands.builtin.ram.xxd import xxd
from mirage.commands.builtin.ram.zcat import zcat
from mirage.commands.builtin.ram.zgrep import zgrep
from mirage.commands.builtin.ram.zip_cmd import zip_cmd
from mirage.core.ram.glob import resolve_glob as _ft_resolve_glob
from mirage.core.ram.read import read_bytes as _ft_read

COMMANDS = [
    *make_filetype_commands("ram", _ft_resolve_glob, _ft_read),
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
