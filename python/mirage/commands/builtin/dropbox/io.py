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

from mirage.core.dropbox.copy import copy as _copy
from mirage.core.dropbox.create import create as _create
from mirage.core.dropbox.exists import exists as _exists
from mirage.core.dropbox.mkdir import mkdir as _mkdir
from mirage.core.dropbox.read import read as _read
from mirage.core.dropbox.read import read_stream as _stream
from mirage.core.dropbox.readdir import readdir as _readdir
from mirage.core.dropbox.rename import rename as _rename
from mirage.core.dropbox.rm import rm_r as _rm_r
from mirage.core.dropbox.rmdir import rmdir as _rmdir
from mirage.core.dropbox.search import narrow_paths
from mirage.core.dropbox.stat import stat as _stat
from mirage.core.dropbox.unlink import unlink as _unlink
from mirage.core.dropbox.write import write as _write
from mirage.core.generic.du import make_walked_du
from mirage.vfs.adapter import VFSAdapter
from mirage.vfs.types import ContentSearchOps, NativeReadOps, ReadOps, WriteOps

# copy_v2 copies folder subtrees server-side, so dir_copy is the same
# call as copy.
IO = VFSAdapter(
    read=ReadOps(readdir=_readdir, read_bytes=_read, stat=_stat),
    native=NativeReadOps(
        read_range=_read,
        read_stream=_stream,
        du=make_walked_du(_stat, _readdir),
        exists=_exists,
    ),
    writes=WriteOps(
        write=_write,
        mkdir=_mkdir,
        unlink=_unlink,
        rmdir=_rmdir,
        rm_r=_rm_r,
        rename=_rename,
        copy=_copy,
        create=_create,
    ),
    content_search=ContentSearchOps(
        narrow_paths=narrow_paths, enabled=lambda a: a.config.content_search
    ),
    is_mounted=lambda a: True,
    local=False,
).to_command_io()

resolve_glob = IO.resolve_glob
