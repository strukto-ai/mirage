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


class SupabaseConfig(RegionEndpointConfig):
    """Supabase Storage's S3 gateway, addressed by project reference."""

    project_ref: str | None = None
    path_style: bool = True

    def resolved_endpoint_url(self) -> str:
        if self.endpoint_url:
            return self.endpoint_url
        if self.project_ref:
            return (
                f"https://{self.project_ref}.storage.supabase.co/storage/v1/s3"
            )
        raise ValueError("SupabaseConfig requires project_ref or endpoint_url")
