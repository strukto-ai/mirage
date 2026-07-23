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

from mirage.commands.builtin.generic_bind import CommandIO
from mirage.core.gridfs.constants import SCOPE_ERROR
from mirage.core.gridfs.copy import copy as _copy
from mirage.core.gridfs.create import create as _create
from mirage.core.gridfs.du import du as _du
from mirage.core.gridfs.du import du_all as _du_all
from mirage.core.gridfs.exists import exists as _exists
from mirage.core.gridfs.find import find as _find
from mirage.core.gridfs.mkdir import mkdir as _mkdir
from mirage.core.gridfs.read import read_bytes as _read
from mirage.core.gridfs.readdir import readdir as _readdir
from mirage.core.gridfs.rename import rename as _rename
from mirage.core.gridfs.rm import rm_r as _rm_r
from mirage.core.gridfs.rmdir import rmdir as _rmdir
from mirage.core.gridfs.stat import stat as _stat
from mirage.core.gridfs.stream import read_stream as _read_stream
from mirage.core.gridfs.truncate import truncate as _truncate
from mirage.core.gridfs.unlink import unlink as _unlink
from mirage.core.gridfs.write import write_bytes as _write

IO = CommandIO(
    readdir=_readdir,
    read_bytes=_read,
    read_stream=_read_stream,
    stat=_stat,
    is_mounted=lambda a: True,
    local=False,
    max_glob_matches=SCOPE_ERROR,
    write=_write,
    exists=_exists,
    mkdir=_mkdir,
    unlink=_unlink,
    rmdir=_rmdir,
    rm_r=_rm_r,
    rename=_rename,
    copy=_copy,
    create=_create,
    find=_find,
    du_total=_du,
    du_all=_du_all,
    truncate=_truncate,
)

resolve_glob = IO.resolve_glob
