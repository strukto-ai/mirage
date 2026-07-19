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

from functools import partial

from mirage.commands.builtin.generic_bind import CommandIO
from mirage.commands.builtin.utils.wrap import stream_from_bytes
from mirage.core.gdrive.copy import copy as _copy
from mirage.core.gdrive.create import create as _create
from mirage.core.gdrive.du import du as _du
from mirage.core.gdrive.du import du_all as _du_all
from mirage.core.gdrive.exists import exists as _exists
from mirage.core.gdrive.find import find as _find
from mirage.core.gdrive.mkdir import mkdir as _mkdir
from mirage.core.gdrive.read import read as _read
from mirage.core.gdrive.readdir import is_dir_name as _is_dir_name
from mirage.core.gdrive.readdir import readdir as _readdir
from mirage.core.gdrive.rename import rename as _rename
from mirage.core.gdrive.rm import rm_r as _rm_r
from mirage.core.gdrive.rmdir import rmdir as _rmdir
from mirage.core.gdrive.stat import stat as _stat
from mirage.core.gdrive.truncate import truncate as _truncate
from mirage.core.gdrive.unlink import unlink as _unlink
from mirage.core.gdrive.write import write_bytes as _write

# Raw bytes read and write via the generic factory; google-native files
# (gdoc/gsheet/gslide) render as API-resource JSON and are mutated through
# the gws commands instead. gdrive's native read_stream is a coroutine
# returning bytes-or-iterator (Workspace-aware), so the stream op is
# synthesized from the whole-file read instead.
IO = CommandIO(
    readdir=_readdir,
    read_bytes=_read,
    read_stream=partial(stream_from_bytes, _read),
    stat=_stat,
    is_dir_name=lambda _accessor, child: _is_dir_name(child),
    is_mounted=lambda a: True,
    local=False,
    write=_write,
    exists=_exists,
    mkdir=_mkdir,
    unlink=_unlink,
    rmdir=_rmdir,
    rm_r=_rm_r,
    rename=_rename,
    copy=_copy,
    dir_copy=_copy,
    create=_create,
    truncate=_truncate,
    find=_find,
    du_total=_du,
    du_all=_du_all,
)

resolve_glob = IO.resolve_glob
