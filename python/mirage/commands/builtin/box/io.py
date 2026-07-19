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
from mirage.core.box.copy import copy as _copy
from mirage.core.box.create import create as _create
from mirage.core.box.exists import exists as _exists
from mirage.core.box.mkdir import mkdir as _mkdir
from mirage.core.box.read import read as _read
from mirage.core.box.read import stream as _stream
from mirage.core.box.readdir import is_dir_name as _is_dir_name
from mirage.core.box.readdir import readdir as _readdir
from mirage.core.box.rename import rename as _rename
from mirage.core.box.rmdir import rm_r as _rm_r
from mirage.core.box.rmdir import rmdir as _rmdir
from mirage.core.box.stat import stat as _stat
from mirage.core.box.truncate import truncate as _truncate
from mirage.core.box.unlink import unlink as _unlink
from mirage.core.box.write import write_bytes as _write

# Box exposes the full write surface (upload/overwrite, mkdir, unlink, rmdir,
# mv, cp) alongside reads. du keeps a bespoke wrapper (like onedrive/hf)
# because box path->id resolution needs the dispatcher-injected index and its
# du_all follows the flat du_multi contract.
IO = CommandIO(
    readdir=_readdir,
    read_bytes=_read,
    read_stream=_stream,
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
)

resolve_glob = IO.resolve_glob
