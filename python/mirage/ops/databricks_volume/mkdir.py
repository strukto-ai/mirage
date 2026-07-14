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

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.cache.index import NULL_INDEX
from mirage.core.databricks_volume.mkdir import mkdir as mkdir_core
from mirage.ops.registry import op
from mirage.types import PathSpec


@op("mkdir", resource="databricks_volume", write=True)
async def mkdir(
    accessor: DatabricksVolumeAccessor,
    path: PathSpec,
    **kwargs,
) -> None:
    await mkdir_core(accessor,
                     path,
                     kwargs.get("index") or NULL_INDEX,
                     parents=True)
