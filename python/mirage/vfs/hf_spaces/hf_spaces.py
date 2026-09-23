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

from mirage.accessor.hf_spaces import HfSpacesAccessor, HfSpacesConfig
from mirage.types import VFSName
from mirage.vfs.hf_hub.base import HfHubVFS
from mirage.vfs.hf_spaces.prompt import PROMPT


class HfSpacesVFS(HfHubVFS[HfSpacesAccessor]):

    ACCESSOR = HfSpacesAccessor
    name: str = VFSName.HF_SPACES
    PROMPT: str = PROMPT

    def __init__(self, config: HfSpacesConfig) -> None:
        super().__init__(config)
