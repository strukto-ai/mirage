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

from mirage.commands.builtin.databricks_volume._helpers import (
    path_prefix, read_bytes_with_index)
from mirage.commands.builtin.generic.sed_command import make_sed
from mirage.core.databricks_volume.glob import resolve_glob

sed = make_sed(
    resource="databricks_volume",
    glob_fn=resolve_glob,
    make_read=lambda accessor, index, paths: read_bytes_with_index(
        index, path_prefix(paths)),
    inplace_error=(
        ValueError,
        "sed: -i is not supported for databricks_volume",
    ),
)
