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
from mirage.core.hf_buckets.create import create as _create
from mirage.core.hf_buckets.du import du as _du
from mirage.core.hf_buckets.du import du_all as _du_all
from mirage.core.hf_buckets.exists import exists as _exists
from mirage.core.hf_buckets.find import find as _find
from mirage.core.hf_buckets.mkdir import mkdir as _mkdir
from mirage.core.hf_buckets.read import read_bytes as _read
from mirage.core.hf_buckets.readdir import readdir as _readdir
from mirage.core.hf_buckets.stat import stat as _stat
from mirage.core.hf_buckets.stream import read_stream as _read_stream
from mirage.core.hf_buckets.unlink import unlink as _unlink
from mirage.core.hf_buckets.write import write_bytes as _write

# Hugging Face bucket files are read and written through the generic factory;
# du keeps a wrapper because its du_all returns a flat list (du_multi contract)
# rather than the generic (list, total) tuple.
# cp and mv are skipped because HF buckets have no server-side copy/rename op.
OPS = CommandIO(
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
    create=_create,
    find=_find,
    du_total=_du,
    du_all=_du_all,
)

RESOLVE_GLOB = OPS.resolve_glob
