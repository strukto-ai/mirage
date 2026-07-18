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
from mirage.commands.builtin.generic_bind import make_generic_commands
from mirage.commands.builtin.s3._provision import \
    file_read_provision as _ft_provision
from mirage.commands.builtin.s3.du import du
from mirage.commands.builtin.s3.io import IO as _IO
from mirage.commands.builtin.s3.mkdir import mkdir
from mirage.commands.builtin.s3.rm import rm
from mirage.commands.builtin.s3.stat import stat
from mirage.commands.builtin.s3.tee import tee
from mirage.commands.builtin.s3.touch import touch
from mirage.core.s3.read import read_bytes as _read

# s3-specific behaviours kept as overrides: no real directories (mkdir -p,
# rm not-empty), write-tracking (touch/tee), du_multi aggregation, and the
# index-threaded, missing-operand stat. patch is generic (the factory builder
# delegates to the shared generic patch).
_S3_OVERRIDES = {"stat", "du", "rm", "mkdir", "tee", "touch"}

COMMANDS = [
    *make_filetype_commands(
        "s3", _IO.resolve_glob, _read, provision=_ft_provision),
    *make_generic_commands(
        "s3",
        _IO,
        overrides=_S3_OVERRIDES,
    ),
    du,
    mkdir,
    rm,
    stat,
    tee,
    touch,
]
