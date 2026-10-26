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

from pydantic import ConfigDict, SecretStr

from mirage.core.api.config import TimeoutConfig


class GitHubConfig(TimeoutConfig):
    model_config = ConfigDict(frozen=True, extra="forbid")

    token: SecretStr
    """GitHub personal access token."""
    owner: str | None = None
    """Repository owner, a user or an organization. Required unless the
    `GitHubVFS` constructor is given `owner`."""
    repo: str | None = None
    """Repository name. Required unless the `GitHubVFS` constructor is
    given `repo`."""
    # None means "whatever the repository's default branch is", resolved on
    # the first read through ``ensure_ref``. It is not a synonym for "main":
    # defaulting to that string mounted a nonexistent ref on every repo whose
    # default is `master`, and the tree fetch 404s rather than falling back.
    ref: str | None = None
    """Branch, tag or commit SHA the mount reads. Unset follows the
    repository's default branch, resolved on the first read."""
    base_url: str | None = None
    """GitHub API root. Unset uses `https://api.github.com`; set it for
    GitHub Enterprise."""


class GhConfig(TimeoutConfig):
    """What a `gh` install is configured with.

    `repo` is what real gh reads off the current git remote to answer a line
    that names no repository; a workspace has no remote, so the install
    carries it. `branch` stands in the same way for the checked-out branch,
    which is what `{branch}` expands to in an endpoint.
    """

    model_config = ConfigDict(extra="forbid")

    token: SecretStr
    base_url: str | None = None
    repo: str | None = None
    branch: str | None = None
