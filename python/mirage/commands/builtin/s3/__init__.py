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
from mirage.commands.builtin.s3._provision import \
    file_read_provision as _ft_provision
from mirage.commands.builtin.s3.awk import awk
from mirage.commands.builtin.s3.base64_cmd import base64_cmd
from mirage.commands.builtin.s3.basename import basename
from mirage.commands.builtin.s3.cat import cat
from mirage.commands.builtin.s3.cmp import cmp_cmd
from mirage.commands.builtin.s3.column import column
from mirage.commands.builtin.s3.comm import comm
from mirage.commands.builtin.s3.cp import cp
from mirage.commands.builtin.s3.csplit import csplit
from mirage.commands.builtin.s3.cut import cut
from mirage.commands.builtin.s3.diff import diff
from mirage.commands.builtin.s3.dirname import dirname
from mirage.commands.builtin.s3.du import du
from mirage.commands.builtin.s3.expand import expand
from mirage.commands.builtin.s3.file import file
from mirage.commands.builtin.s3.find import find
from mirage.commands.builtin.s3.fmt import fmt
from mirage.commands.builtin.s3.fold import fold
from mirage.commands.builtin.s3.grep import grep
from mirage.commands.builtin.s3.gunzip import gunzip
from mirage.commands.builtin.s3.gzip import gzip
from mirage.commands.builtin.s3.head import head
from mirage.commands.builtin.s3.iconv import iconv
from mirage.commands.builtin.s3.join import join
from mirage.commands.builtin.s3.jq import jq
from mirage.commands.builtin.s3.ln import ln
from mirage.commands.builtin.s3.look import look
from mirage.commands.builtin.s3.ls import ls
from mirage.commands.builtin.s3.md5 import md5
from mirage.commands.builtin.s3.mkdir import mkdir
from mirage.commands.builtin.s3.mktemp import mktemp
from mirage.commands.builtin.s3.mv import mv
from mirage.commands.builtin.s3.nl import nl
from mirage.commands.builtin.s3.paste import paste
from mirage.commands.builtin.s3.patch import patch
from mirage.commands.builtin.s3.readlink import readlink
from mirage.commands.builtin.s3.realpath import realpath
from mirage.commands.builtin.s3.rev import rev
from mirage.commands.builtin.s3.rg import rg
from mirage.commands.builtin.s3.rm import rm
from mirage.commands.builtin.s3.sed import sed
from mirage.commands.builtin.s3.sha256sum import sha256sum
from mirage.commands.builtin.s3.shuf import shuf
from mirage.commands.builtin.s3.sort import sort
from mirage.commands.builtin.s3.split import split
from mirage.commands.builtin.s3.stat import stat
from mirage.commands.builtin.s3.strings import strings
from mirage.commands.builtin.s3.tac import tac
from mirage.commands.builtin.s3.tail import tail
from mirage.commands.builtin.s3.tar import tar
from mirage.commands.builtin.s3.tee import tee
from mirage.commands.builtin.s3.touch import touch
from mirage.commands.builtin.s3.tr import tr
from mirage.commands.builtin.s3.tree import tree
from mirage.commands.builtin.s3.tsort import tsort
from mirage.commands.builtin.s3.unexpand import unexpand
from mirage.commands.builtin.s3.uniq import uniq
from mirage.commands.builtin.s3.unzip import unzip as unzip_cmd
from mirage.commands.builtin.s3.wc import wc
from mirage.commands.builtin.s3.xxd import xxd
from mirage.commands.builtin.s3.zcat import zcat
from mirage.commands.builtin.s3.zgrep import zgrep
from mirage.commands.builtin.s3.zip_cmd import zip_cmd
from mirage.core.s3.glob import resolve_glob as _ft_resolve_glob
from mirage.core.s3.read import read_bytes as _ft_read

COMMANDS = [
    *make_filetype_commands(
        "s3", _ft_resolve_glob, _ft_read, provision=_ft_provision),
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
