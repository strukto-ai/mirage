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

from mirage.commands.builtin.disk.cmp import cmp_cmd
from mirage.commands.builtin.disk.csplit import csplit
from mirage.commands.builtin.disk.diff import diff
from mirage.commands.builtin.disk.gunzip import gunzip
from mirage.commands.builtin.disk.gzip import gzip
from mirage.commands.builtin.disk.mktemp import mktemp
from mirage.commands.builtin.disk.patch import patch
from mirage.commands.builtin.disk.sed import sed
from mirage.commands.builtin.disk.shuf import shuf
from mirage.commands.builtin.disk.split import split
from mirage.commands.builtin.disk.tar import tar
from mirage.commands.builtin.disk.tsort import tsort
from mirage.commands.builtin.disk.unzip import unzip as unzip_cmd
from mirage.commands.builtin.disk.zcat import zcat
from mirage.commands.builtin.disk.zip_cmd import zip_cmd
from mirage.commands.builtin.filetype_factory import make_filetype_commands
from mirage.commands.builtin.generic_bind import (CommandIO,
                                                  make_generic_commands)
from mirage.core.disk.constants import SCOPE_ERROR
from mirage.core.disk.copy import copy as _copy
from mirage.core.disk.du import du as _du
from mirage.core.disk.du import du_all as _du_all
from mirage.core.disk.exists import exists as _exists
from mirage.core.disk.find import find as _find
from mirage.core.disk.glob import resolve_glob as _ft_resolve_glob
from mirage.core.disk.mkdir import mkdir as _mkdir
from mirage.core.disk.read import read_bytes as _read
from mirage.core.disk.readdir import readdir as _readdir
from mirage.core.disk.rename import rename as _rename
from mirage.core.disk.rm import rm_r as _rm_r
from mirage.core.disk.rmdir import rmdir as _rmdir
from mirage.core.disk.stat import stat as _stat
from mirage.core.disk.stream import read_stream as _read_stream
from mirage.core.disk.unlink import unlink as _unlink
from mirage.core.disk.write import write_bytes as _write

_DISK_CMD_OPS = CommandIO(
    readdir=_readdir,
    read_bytes=_read,
    read_stream=_read_stream,
    stat=_stat,
    ready=lambda a: a.root is not None,
    local=True,
    scope_cap=SCOPE_ERROR,
    write=_write,
    exists=_exists,
    mkdir=_mkdir,
    unlink=_unlink,
    rmdir=_rmdir,
    rm_r=_rm_r,
    rename=_rename,
    copy=_copy,
    find=_find,
    du_total=_du,
    du_all=_du_all,
)

COMMANDS = [
    *make_filetype_commands("disk", _ft_resolve_glob, _read),
    *make_generic_commands("disk", _DISK_CMD_OPS),
    cmp_cmd,
    csplit,
    diff,
    gunzip,
    gzip,
    mktemp,
    patch,
    sed,
    shuf,
    split,
    tar,
    tsort,
    unzip_cmd,
    zcat,
    zip_cmd,
]
