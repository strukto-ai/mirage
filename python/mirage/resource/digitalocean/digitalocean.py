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

from typing import Any

from mirage.resource.digitalocean.config import DigitalOceanConfig
from mirage.resource.digitalocean.prompt import PROMPT
from mirage.resource.s3 import S3Resource


class DigitalOceanResource(S3Resource):

    PROMPT: str = PROMPT

    def __init__(self, config: DigitalOceanConfig) -> None:
        self.digitalocean_config = config
        super().__init__(config.to_s3_config())

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.digitalocean_config)

    def load_state(self, state: dict[str, Any]) -> None:
        pass
