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

from mirage.commands.builtin.hf_buckets.awk import awk
from mirage.commands.builtin.hf_buckets.base64_cmd import base64_cmd
from mirage.commands.builtin.hf_buckets.basename import basename
from mirage.commands.builtin.hf_buckets.cat import cat
from mirage.commands.builtin.hf_buckets.cmp import cmp_cmd
from mirage.commands.builtin.hf_buckets.column import column
from mirage.commands.builtin.hf_buckets.comm import comm
from mirage.commands.builtin.hf_buckets.csplit import csplit
from mirage.commands.builtin.hf_buckets.cut import cut
from mirage.commands.builtin.hf_buckets.diff import diff
from mirage.commands.builtin.hf_buckets.dirname import dirname
from mirage.commands.builtin.hf_buckets.du import du
from mirage.commands.builtin.hf_buckets.expand import expand
from mirage.commands.builtin.hf_buckets.file import file
from mirage.commands.builtin.hf_buckets.find import find
from mirage.commands.builtin.hf_buckets.fmt import fmt
from mirage.commands.builtin.hf_buckets.fold import fold
from mirage.commands.builtin.hf_buckets.grep import grep
from mirage.commands.builtin.hf_buckets.gunzip import gunzip
from mirage.commands.builtin.hf_buckets.gzip import gzip
from mirage.commands.builtin.hf_buckets.head import head
from mirage.commands.builtin.hf_buckets.iconv import iconv
from mirage.commands.builtin.hf_buckets.join import join
from mirage.commands.builtin.hf_buckets.jq import jq
from mirage.commands.builtin.hf_buckets.look import look
from mirage.commands.builtin.hf_buckets.ls import ls
from mirage.commands.builtin.hf_buckets.md5 import md5
from mirage.commands.builtin.hf_buckets.mktemp import mktemp
from mirage.commands.builtin.hf_buckets.nl import nl
from mirage.commands.builtin.hf_buckets.paste import paste
from mirage.commands.builtin.hf_buckets.readlink import readlink
from mirage.commands.builtin.hf_buckets.realpath import realpath
from mirage.commands.builtin.hf_buckets.rev import rev
from mirage.commands.builtin.hf_buckets.rg import rg
from mirage.commands.builtin.hf_buckets.rm import rm
from mirage.commands.builtin.hf_buckets.sed import sed
from mirage.commands.builtin.hf_buckets.sha256sum import sha256sum
from mirage.commands.builtin.hf_buckets.shuf import shuf
from mirage.commands.builtin.hf_buckets.sort import sort
from mirage.commands.builtin.hf_buckets.split import split
from mirage.commands.builtin.hf_buckets.stat import stat
from mirage.commands.builtin.hf_buckets.strings import strings
from mirage.commands.builtin.hf_buckets.tac import tac
from mirage.commands.builtin.hf_buckets.tail import tail
from mirage.commands.builtin.hf_buckets.tar import tar
from mirage.commands.builtin.hf_buckets.touch import touch
from mirage.commands.builtin.hf_buckets.tr import tr
from mirage.commands.builtin.hf_buckets.tree import tree
from mirage.commands.builtin.hf_buckets.tsort import tsort
from mirage.commands.builtin.hf_buckets.unexpand import unexpand
from mirage.commands.builtin.hf_buckets.uniq import uniq
from mirage.commands.builtin.hf_buckets.unzip import unzip
from mirage.commands.builtin.hf_buckets.wc import wc
from mirage.commands.builtin.hf_buckets.xxd import xxd
from mirage.commands.builtin.hf_buckets.zcat import zcat
from mirage.commands.builtin.hf_buckets.zgrep import zgrep
from mirage.commands.builtin.hf_buckets.zip_cmd import zip_cmd

COMMANDS = [
    awk,
    base64_cmd,
    basename,
    cat,
    cmp_cmd,
    column,
    comm,
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
    look,
    ls,
    md5,
    mktemp,
    nl,
    paste,
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
    touch,
    tr,
    tree,
    tsort,
    unexpand,
    uniq,
    unzip,
    wc,
    xxd,
    zcat,
    zgrep,
    zip_cmd,
]
