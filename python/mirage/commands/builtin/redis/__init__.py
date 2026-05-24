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
from mirage.commands.builtin.redis.awk import awk
from mirage.commands.builtin.redis.base64_cmd import base64_cmd
from mirage.commands.builtin.redis.basename import basename
from mirage.commands.builtin.redis.cat import COMMANDS as _CAT_COMMANDS
from mirage.commands.builtin.redis.cmp import cmp_cmd
from mirage.commands.builtin.redis.column import column
from mirage.commands.builtin.redis.comm import comm
from mirage.commands.builtin.redis.cp import cp
from mirage.commands.builtin.redis.csplit import csplit
from mirage.commands.builtin.redis.cut import COMMANDS as _CUT_COMMANDS
from mirage.commands.builtin.redis.diff import diff
from mirage.commands.builtin.redis.dirname import dirname
from mirage.commands.builtin.redis.du import du
from mirage.commands.builtin.redis.expand import expand
from mirage.commands.builtin.redis.file import COMMANDS as _FILE_COMMANDS
from mirage.commands.builtin.redis.find import find
from mirage.commands.builtin.redis.fmt import fmt
from mirage.commands.builtin.redis.fold import fold
from mirage.commands.builtin.redis.grep import COMMANDS as _GREP_COMMANDS
from mirage.commands.builtin.redis.gunzip import gunzip
from mirage.commands.builtin.redis.gzip import gzip
from mirage.commands.builtin.redis.head import COMMANDS as _HEAD_COMMANDS
from mirage.commands.builtin.redis.iconv import iconv
from mirage.commands.builtin.redis.join import join
from mirage.commands.builtin.redis.jq import jq
from mirage.commands.builtin.redis.ln import ln
from mirage.commands.builtin.redis.look import look
from mirage.commands.builtin.redis.ls import COMMANDS as _LS_COMMANDS
from mirage.commands.builtin.redis.md5 import md5
from mirage.commands.builtin.redis.mkdir import mkdir
from mirage.commands.builtin.redis.mktemp import mktemp
from mirage.commands.builtin.redis.mv import mv
from mirage.commands.builtin.redis.nl import nl
from mirage.commands.builtin.redis.paste import paste
from mirage.commands.builtin.redis.patch import patch
from mirage.commands.builtin.redis.readlink import readlink
from mirage.commands.builtin.redis.realpath import realpath
from mirage.commands.builtin.redis.rev import rev
from mirage.commands.builtin.redis.rg import rg
from mirage.commands.builtin.redis.rm import rm
from mirage.commands.builtin.redis.sed import sed
from mirage.commands.builtin.redis.sha256sum import sha256sum
from mirage.commands.builtin.redis.shuf import shuf
from mirage.commands.builtin.redis.sort import sort
from mirage.commands.builtin.redis.split import split
from mirage.commands.builtin.redis.stat import COMMANDS as _STAT_COMMANDS
from mirage.commands.builtin.redis.strings import strings
from mirage.commands.builtin.redis.tac import tac
from mirage.commands.builtin.redis.tail import COMMANDS as _TAIL_COMMANDS
from mirage.commands.builtin.redis.tar import tar
from mirage.commands.builtin.redis.tee import tee
from mirage.commands.builtin.redis.touch import touch
from mirage.commands.builtin.redis.tr import tr
from mirage.commands.builtin.redis.tree import tree
from mirage.commands.builtin.redis.tsort import tsort
from mirage.commands.builtin.redis.unexpand import unexpand
from mirage.commands.builtin.redis.uniq import uniq
from mirage.commands.builtin.redis.unzip import unzip as unzip_cmd
from mirage.commands.builtin.redis.wc import COMMANDS as _WC_COMMANDS
from mirage.commands.builtin.redis.xxd import xxd
from mirage.commands.builtin.redis.zcat import zcat
from mirage.commands.builtin.redis.zgrep import zgrep
from mirage.commands.builtin.redis.zip_cmd import zip_cmd
from mirage.core.redis.glob import resolve_glob as _ft_resolve_glob
from mirage.core.redis.read import read_bytes as _ft_read

COMMANDS = [
    *make_filetype_commands("redis", _ft_resolve_glob, _ft_read),
    awk,
    base64_cmd,
    basename,
    *_CAT_COMMANDS,
    cmp_cmd,
    column,
    comm,
    cp,
    csplit,
    *_CUT_COMMANDS,
    diff,
    dirname,
    du,
    expand,
    *_FILE_COMMANDS,
    find,
    fmt,
    fold,
    *_GREP_COMMANDS,
    gunzip,
    gzip,
    *_HEAD_COMMANDS,
    iconv,
    join,
    jq,
    ln,
    look,
    *_LS_COMMANDS,
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
    *_STAT_COMMANDS,
    strings,
    tac,
    *_TAIL_COMMANDS,
    tar,
    tee,
    touch,
    tr,
    tree,
    tsort,
    unexpand,
    uniq,
    unzip_cmd,
    *_WC_COMMANDS,
    xxd,
    zcat,
    zgrep,
    zip_cmd,
]
