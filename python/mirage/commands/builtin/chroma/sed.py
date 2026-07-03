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

from mirage.commands.builtin.generic.sed_command import make_sed
from mirage.core.chroma.glob import resolve_glob
from mirage.core.chroma.read import read_bytes
from mirage.core.chroma.stat import stat as _stat

sed = make_sed(
    stat_fn=_stat,
    resource="chroma",
    glob_fn=resolve_glob,
    make_read=lambda accessor, index, paths: partial(read_bytes, index=index),
    inplace_error=(
        PermissionError,
        "sed -i not supported on read-only Chroma mount",
    ),
)
