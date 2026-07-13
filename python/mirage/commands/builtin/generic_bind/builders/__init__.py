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

# yapf: disable
# isort: skip_file
from mirage.commands.builtin.generic_bind.builders import awk
from mirage.commands.builtin.generic_bind.builders import base64
from mirage.commands.builtin.generic_bind.builders import basename
from mirage.commands.builtin.generic_bind.builders import cat
from mirage.commands.builtin.generic_bind.builders import cmp
from mirage.commands.builtin.generic_bind.builders import column
from mirage.commands.builtin.generic_bind.builders import comm
from mirage.commands.builtin.generic_bind.builders import cp
from mirage.commands.builtin.generic_bind.builders import csplit
from mirage.commands.builtin.generic_bind.builders import cut
from mirage.commands.builtin.generic_bind.builders import diff
from mirage.commands.builtin.generic_bind.builders import dirname
from mirage.commands.builtin.generic_bind.builders import du
from mirage.commands.builtin.generic_bind.builders import expand
from mirage.commands.builtin.generic_bind.builders import file
from mirage.commands.builtin.generic_bind.builders import find
from mirage.commands.builtin.generic_bind.builders import fmt
from mirage.commands.builtin.generic_bind.builders import fold
from mirage.commands.builtin.generic_bind.builders import grep
from mirage.commands.builtin.generic_bind.builders import gunzip
from mirage.commands.builtin.generic_bind.builders import gzip
from mirage.commands.builtin.generic_bind.builders import head
from mirage.commands.builtin.generic_bind.builders import iconv
from mirage.commands.builtin.generic_bind.builders import join
from mirage.commands.builtin.generic_bind.builders import jq
from mirage.commands.builtin.generic_bind.builders import ln
from mirage.commands.builtin.generic_bind.builders import look
from mirage.commands.builtin.generic_bind.builders import ls
from mirage.commands.builtin.generic_bind.builders import md5
from mirage.commands.builtin.generic_bind.builders import mkdir
from mirage.commands.builtin.generic_bind.builders import mktemp
from mirage.commands.builtin.generic_bind.builders import mv
from mirage.commands.builtin.generic_bind.builders import nl
from mirage.commands.builtin.generic_bind.builders import paste
from mirage.commands.builtin.generic_bind.builders import patch
from mirage.commands.builtin.generic_bind.builders import readlink
from mirage.commands.builtin.generic_bind.builders import realpath
from mirage.commands.builtin.generic_bind.builders import rev
from mirage.commands.builtin.generic_bind.builders import rg
from mirage.commands.builtin.generic_bind.builders import rm
from mirage.commands.builtin.generic_bind.builders import sed
from mirage.commands.builtin.generic_bind.builders import sha256sum
from mirage.commands.builtin.generic_bind.builders import shuf
from mirage.commands.builtin.generic_bind.builders import sort
from mirage.commands.builtin.generic_bind.builders import split
from mirage.commands.builtin.generic_bind.builders import stat
from mirage.commands.builtin.generic_bind.builders import strings
from mirage.commands.builtin.generic_bind.builders import tac
from mirage.commands.builtin.generic_bind.builders import tail
from mirage.commands.builtin.generic_bind.builders import tar
from mirage.commands.builtin.generic_bind.builders import tee
from mirage.commands.builtin.generic_bind.builders import touch
from mirage.commands.builtin.generic_bind.builders import tr
from mirage.commands.builtin.generic_bind.builders import tree
from mirage.commands.builtin.generic_bind.builders import tsort
from mirage.commands.builtin.generic_bind.builders import unexpand
from mirage.commands.builtin.generic_bind.builders import uniq
from mirage.commands.builtin.generic_bind.builders import unzip
from mirage.commands.builtin.generic_bind.builders import wc
from mirage.commands.builtin.generic_bind.builders import xxd
from mirage.commands.builtin.generic_bind.builders import zcat
from mirage.commands.builtin.generic_bind.builders import zgrep
from mirage.commands.builtin.generic_bind.builders import zip_cmd
# yapf: enable

_BUILDERS = (
    awk.BUILDER,
    base64.BUILDER,
    basename.BUILDER,
    cat.BUILDER,
    cmp.BUILDER,
    column.BUILDER,
    comm.BUILDER,
    cp.BUILDER,
    csplit.BUILDER,
    cut.BUILDER,
    diff.BUILDER,
    dirname.BUILDER,
    du.BUILDER,
    expand.BUILDER,
    file.BUILDER,
    find.BUILDER,
    fmt.BUILDER,
    fold.BUILDER,
    grep.BUILDER,
    gunzip.BUILDER,
    gzip.BUILDER,
    head.BUILDER,
    iconv.BUILDER,
    join.BUILDER,
    jq.BUILDER,
    ln.BUILDER,
    look.BUILDER,
    ls.BUILDER,
    md5.BUILDER,
    mkdir.BUILDER,
    mktemp.BUILDER,
    mv.BUILDER,
    nl.BUILDER,
    paste.BUILDER,
    patch.BUILDER,
    readlink.BUILDER,
    realpath.BUILDER,
    rev.BUILDER,
    rg.BUILDER,
    rm.BUILDER,
    sed.BUILDER,
    sha256sum.BUILDER,
    shuf.BUILDER,
    sort.BUILDER,
    split.BUILDER,
    stat.BUILDER,
    strings.BUILDER,
    tac.BUILDER,
    tail.BUILDER,
    tar.BUILDER,
    tee.BUILDER,
    touch.BUILDER,
    tr.BUILDER,
    tree.BUILDER,
    tsort.BUILDER,
    unexpand.BUILDER,
    uniq.BUILDER,
    unzip.BUILDER,
    wc.BUILDER,
    xxd.BUILDER,
    zcat.BUILDER,
    zgrep.BUILDER,
    zip_cmd.BUILDER,
)

__all__ = ["_BUILDERS"]
