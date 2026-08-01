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

from mirage.resource.s3_alias import RegionEndpointConfig


class WasabiConfig(RegionEndpointConfig):
    """Wasabi, whose default region addresses a region-less host.

    Every other region takes the usual segment, so only ``us-east-1``
    needs the override. Matches the TypeScript alias.
    """

    ENDPOINT = "https://s3.{region}.wasabisys.com"

    region: str = "us-east-1"

    def resolved_endpoint_url(self) -> str:
        if not self.endpoint_url and self.region == "us-east-1":
            return "https://s3.wasabisys.com"
        return super().resolved_endpoint_url()
