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

from mirage.commands.builtin.databricks_volume.head import head
from mirage.commands.builtin.databricks_volume.sed import sed
from mirage.commands.builtin.generic_bind import (CommandIO,
                                                  make_generic_commands)
from mirage.core.databricks_volume.copy import copy as _copy
from mirage.core.databricks_volume.create import create as _create
from mirage.core.databricks_volume.exists import exists as _exists
from mirage.core.databricks_volume.mkdir import mkdir as _mkdir
from mirage.core.databricks_volume.read import read_bytes as _read
from mirage.core.databricks_volume.readdir import readdir as _readdir
from mirage.core.databricks_volume.rename import rename as _rename
from mirage.core.databricks_volume.rm import rm_recursive as _rm_r
from mirage.core.databricks_volume.rmdir import rmdir as _rmdir
from mirage.core.databricks_volume.stat import stat as _stat
from mirage.core.databricks_volume.stream import read_stream as _read_stream
from mirage.core.databricks_volume.unlink import unlink as _unlink
from mirage.core.databricks_volume.write import write_bytes as _write

# Databricks Volume files are read and written through the generic factory;
# head keeps a wrapper because -c fetches only the first N bytes via a single
# range request instead of streaming the whole file, and sed has no generic
# builder.
_DATABRICKS_CMD_OPS = CommandIO(
    readdir=_readdir,
    read_bytes=_read,
    read_stream=_read_stream,
    stat=_stat,
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
    create=_create,
)

_DATABRICKS_OVERRIDES = {"head", "sed"}

COMMANDS = [
    *make_generic_commands(
        "databricks_volume",
        _DATABRICKS_CMD_OPS,
        overrides=_DATABRICKS_OVERRIDES,
    ),
    head,
    sed,
]
