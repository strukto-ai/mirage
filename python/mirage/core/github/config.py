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

from pydantic import BaseModel, SecretStr


class GitHubConfig(BaseModel):
    token: SecretStr
    owner: str | None = None
    repo: str | None = None
    ref: str = "main"
    base_url: str | None = None


class GhConfig(BaseModel):
    """What a `gh` install is configured with.

    `repo` is what real gh reads off the current git remote to answer a line
    that names no repository; a workspace has no remote, so the install
    carries it. `branch` stands in the same way for the checked-out branch,
    which is what `{branch}` expands to in an endpoint.
    """

    token: SecretStr
    base_url: str | None = None
    repo: str | None = None
    branch: str | None = None
