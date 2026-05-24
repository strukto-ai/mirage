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
from mirage.commands.builtin.ssh._provision import \
    file_read_provision as _ft_provision
from mirage.commands.builtin.ssh.awk import awk
from mirage.commands.builtin.ssh.base64_cmd import base64_cmd
from mirage.commands.builtin.ssh.basename import basename
from mirage.commands.builtin.ssh.cat import cat
from mirage.commands.builtin.ssh.cmp import cmp_cmd
from mirage.commands.builtin.ssh.column import column
from mirage.commands.builtin.ssh.comm import comm
from mirage.commands.builtin.ssh.cp import cp
from mirage.commands.builtin.ssh.csplit import csplit
from mirage.commands.builtin.ssh.cut import cut
from mirage.commands.builtin.ssh.diff import diff
from mirage.commands.builtin.ssh.dirname import dirname
from mirage.commands.builtin.ssh.du import du
from mirage.commands.builtin.ssh.expand import expand
from mirage.commands.builtin.ssh.file import file
from mirage.commands.builtin.ssh.find import find
from mirage.commands.builtin.ssh.fmt import fmt
from mirage.commands.builtin.ssh.fold import fold
from mirage.commands.builtin.ssh.grep import grep
from mirage.commands.builtin.ssh.gunzip import gunzip
from mirage.commands.builtin.ssh.gzip import gzip
from mirage.commands.builtin.ssh.head import head
from mirage.commands.builtin.ssh.iconv import iconv
from mirage.commands.builtin.ssh.join import join
from mirage.commands.builtin.ssh.jq import jq
from mirage.commands.builtin.ssh.ln import ln
from mirage.commands.builtin.ssh.look import look
from mirage.commands.builtin.ssh.ls import ls
from mirage.commands.builtin.ssh.md5 import md5
from mirage.commands.builtin.ssh.mkdir import mkdir
from mirage.commands.builtin.ssh.mktemp import mktemp
from mirage.commands.builtin.ssh.mv import mv
from mirage.commands.builtin.ssh.nl import nl
from mirage.commands.builtin.ssh.paste import paste
from mirage.commands.builtin.ssh.patch import patch
from mirage.commands.builtin.ssh.readlink import readlink
from mirage.commands.builtin.ssh.realpath import realpath
from mirage.commands.builtin.ssh.rev import rev
from mirage.commands.builtin.ssh.rg import rg
from mirage.commands.builtin.ssh.rm import rm
from mirage.commands.builtin.ssh.sed import sed
from mirage.commands.builtin.ssh.sha256sum import sha256sum
from mirage.commands.builtin.ssh.shuf import shuf
from mirage.commands.builtin.ssh.sort import sort
from mirage.commands.builtin.ssh.split import split
from mirage.commands.builtin.ssh.stat import stat
from mirage.commands.builtin.ssh.strings import strings
from mirage.commands.builtin.ssh.tac import tac
from mirage.commands.builtin.ssh.tail import tail
from mirage.commands.builtin.ssh.tar import tar
from mirage.commands.builtin.ssh.tee import tee
from mirage.commands.builtin.ssh.touch import touch
from mirage.commands.builtin.ssh.tr import tr
from mirage.commands.builtin.ssh.tree import tree
from mirage.commands.builtin.ssh.tsort import tsort
from mirage.commands.builtin.ssh.unexpand import unexpand
from mirage.commands.builtin.ssh.uniq import uniq
from mirage.commands.builtin.ssh.unzip import unzip as unzip_cmd
from mirage.commands.builtin.ssh.wc import wc
from mirage.commands.builtin.ssh.xxd import xxd
from mirage.commands.builtin.ssh.zcat import zcat
from mirage.commands.builtin.ssh.zgrep import zgrep
from mirage.commands.builtin.ssh.zip_cmd import zip_cmd
from mirage.core.ssh.glob import resolve_glob as _ft_resolve_glob
from mirage.core.ssh.read import read_bytes as _ft_read

COMMANDS = [
    *make_filetype_commands(
        "ssh", _ft_resolve_glob, _ft_read, provision=_ft_provision),
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
