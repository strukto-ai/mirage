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

from mirage.commands.builtin.generic.sed_command import make_sed
from mirage.core.onedrive.glob import resolve_glob
from mirage.core.onedrive.read import read_bytes
from mirage.core.onedrive.write import write_bytes

sed = make_sed(
    resource="onedrive",
    glob_fn=resolve_glob,
    make_read=lambda accessor, index, paths: read_bytes,
    write_bytes=write_bytes,
)
