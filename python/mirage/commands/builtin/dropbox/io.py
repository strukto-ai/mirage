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
from mirage.core.dropbox.copy import copy as _copy
from mirage.core.dropbox.create import create as _create
from mirage.core.dropbox.exists import exists as _exists
from mirage.core.dropbox.mkdir import mkdir as _mkdir
from mirage.core.dropbox.read import read as _read
from mirage.core.dropbox.read import stream as _stream
from mirage.core.dropbox.readdir import is_dir_name as _is_dir_name
from mirage.core.dropbox.readdir import readdir as _readdir
from mirage.core.dropbox.rename import rename as _rename
from mirage.core.dropbox.rm import rm_r as _rm_r
from mirage.core.dropbox.rmdir import rmdir as _rmdir
from mirage.core.dropbox.stat import stat as _stat
from mirage.core.dropbox.unlink import unlink as _unlink
from mirage.core.dropbox.write import write_bytes as _write

# copy_v2 copies folder subtrees server-side, so dir_copy is the same
# call as copy. du falls back to the generic readdir+stat walk.
IO = CommandIO(
    readdir=_readdir,
    read_bytes=_read,
    read_stream=_stream,
    stat=_stat,
    is_mounted=lambda a: True,
    is_dir_name=lambda a, child: _is_dir_name(child),
    local=False,
    write=_write,
    exists=_exists,
    mkdir=_mkdir,
    unlink=_unlink,
    rmdir=_rmdir,
    rm_r=_rm_r,
    rename=_rename,
    # No dir_copy: cp -r must MERGE into an existing destination dir, so
    # the builder plans file-by-file copies (copy_v2 on a whole folder
    # rejects an existing destination).
    copy=_copy,
    create=_create,
)

resolve_glob = IO.resolve_glob
