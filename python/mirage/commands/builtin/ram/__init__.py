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
from mirage.commands.builtin.generic_bind import (CommandIO,
                                                  make_generic_commands)
from mirage.commands.builtin.ram.cmp import cmp_cmd
from mirage.commands.builtin.ram.csplit import csplit
from mirage.commands.builtin.ram.diff import diff
from mirage.commands.builtin.ram.gunzip import gunzip
from mirage.commands.builtin.ram.gzip import gzip
from mirage.commands.builtin.ram.mktemp import mktemp
from mirage.commands.builtin.ram.patch import patch
from mirage.commands.builtin.ram.sed import sed
from mirage.commands.builtin.ram.shuf import shuf
from mirage.commands.builtin.ram.split import split
from mirage.commands.builtin.ram.tar import tar
from mirage.commands.builtin.ram.tsort import tsort
from mirage.commands.builtin.ram.unzip import unzip as unzip_cmd
from mirage.commands.builtin.ram.zcat import zcat
from mirage.commands.builtin.ram.zip_cmd import zip_cmd
from mirage.core.ram.constants import SCOPE_ERROR
from mirage.core.ram.copy import copy as _copy
from mirage.core.ram.du import du as _du
from mirage.core.ram.du import du_all as _du_all
from mirage.core.ram.exists import exists as _exists
from mirage.core.ram.find import find as _find
from mirage.core.ram.glob import resolve_glob as _ft_resolve_glob
from mirage.core.ram.mkdir import mkdir as _mkdir
from mirage.core.ram.read import read as _read
from mirage.core.ram.read import read_bytes as _ft_read
from mirage.core.ram.readdir import readdir as _readdir
from mirage.core.ram.rename import rename as _rename
from mirage.core.ram.rm import rm_r as _rm_r
from mirage.core.ram.rmdir import rmdir as _rmdir
from mirage.core.ram.stat import stat as _stat
from mirage.core.ram.stream import read_stream as _read_stream
from mirage.core.ram.unlink import unlink as _unlink
from mirage.core.ram.write import write_bytes as _write

_RAM_CMD_OPS = CommandIO(
    readdir=_readdir,
    read_bytes=_read,
    read_stream=_read_stream,
    stat=_stat,
    is_mounted=lambda a: a.store is not None,
    local=True,
    max_glob_matches=SCOPE_ERROR,
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
    *make_filetype_commands("ram", _ft_resolve_glob, _ft_read),
    *make_generic_commands("ram", _RAM_CMD_OPS),
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
