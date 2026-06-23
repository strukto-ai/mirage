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
from . import (awk, base64, basename, cat, column, comm, cp, cut, dirname, du,
               expand, file, find, fmt, fold, grep, head, iconv, join, jq, ln,
               look, ls, md5, mkdir, mv, nl, paste, readlink, realpath, rev,
               rg, rm, sha256sum, sort, stat, strings, tac, tail, tee, touch,
               tr, tree, unexpand, uniq, wc, xxd, zgrep)
# yapf: enable

_BUILDERS = (
    awk.BUILDER,
    base64.BUILDER,
    basename.BUILDER,
    cat.BUILDER,
    column.BUILDER,
    comm.BUILDER,
    cp.BUILDER,
    cut.BUILDER,
    dirname.BUILDER,
    du.BUILDER,
    expand.BUILDER,
    file.BUILDER,
    find.BUILDER,
    fmt.BUILDER,
    fold.BUILDER,
    grep.BUILDER,
    head.BUILDER,
    iconv.BUILDER,
    join.BUILDER,
    jq.BUILDER,
    ln.BUILDER,
    look.BUILDER,
    ls.BUILDER,
    md5.BUILDER,
    mkdir.BUILDER,
    mv.BUILDER,
    nl.BUILDER,
    paste.BUILDER,
    readlink.BUILDER,
    realpath.BUILDER,
    rev.BUILDER,
    rg.BUILDER,
    rm.BUILDER,
    sha256sum.BUILDER,
    sort.BUILDER,
    stat.BUILDER,
    strings.BUILDER,
    tac.BUILDER,
    tail.BUILDER,
    tee.BUILDER,
    touch.BUILDER,
    tr.BUILDER,
    tree.BUILDER,
    unexpand.BUILDER,
    uniq.BUILDER,
    wc.BUILDER,
    xxd.BUILDER,
    zgrep.BUILDER,
)

__all__ = ["_BUILDERS"]
