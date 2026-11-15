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

from pydantic import BaseModel, ConfigDict, SecretStr, model_validator

from mirage.core.api.config import TimeoutConfig


class GitHubAppAuth(BaseModel):
    """A GitHub App installation that mirage mints tokens for.

    Each token lasts an hour; mirage mints the next one before the last
    expires, so a long-lived VFS or `gh` install keeps working.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    app_id: int | str
    """The App's ID, or its client ID."""
    private_key: SecretStr
    """The App's private key, PEM, PKCS#1 as GitHub downloads it or
    PKCS#8."""
    installation_id: int
    """The installation the tokens act for."""
    repositories: list[str] | None = None
    """Repository names the tokens are narrowed to. Unset reaches every
    repository the installation does."""
    permissions: dict[str, str] | None = None
    """Permissions the tokens are narrowed to, such as
    `{"contents": "read"}`. Unset grants all the installation has."""


def _require_one(token: SecretStr | None, app: GitHubAppAuth | None) -> None:
    """Refuse a GitHub config that names both credentials or neither.

    Args:
        token (SecretStr | None): the fixed token.
        app (GitHubAppAuth | None): the App installation.

    Raises:
        ValueError: both or neither were set.
    """
    if (token is None) == (app is None):
        got = "both" if token is not None else "neither"
        raise ValueError(
            f"GitHub auth takes exactly one of token or app; got {got}"
        )


class GitHubConfig(TimeoutConfig):
    model_config = ConfigDict(frozen=True, extra="forbid")

    token: SecretStr | None = None
    """GitHub token: a personal access token, an OAuth token or an App
    installation token. Exactly one of `token` and `app` is set."""
    app: GitHubAppAuth | None = None
    """A GitHub App installation mirage mints and refreshes tokens for.
    Exactly one of `token` and `app` is set."""
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

    @model_validator(mode="after")
    def _one_credential(self) -> "GitHubConfig":
        _require_one(self.token, self.app)
        return self


class GhConfig(TimeoutConfig):
    """What a `gh` install is configured with.

    `repo` is what real gh reads off the current git remote to answer a line
    that names no repository; a workspace has no remote, so the install
    carries it. `branch` stands in the same way for the checked-out branch,
    which is what `{branch}` expands to in an endpoint.
    """

    model_config = ConfigDict(extra="forbid")

    token: SecretStr | None = None
    app: GitHubAppAuth | None = None
    base_url: str | None = None
    repo: str | None = None
    branch: str | None = None

    @model_validator(mode="after")
    def _one_credential(self) -> "GhConfig":
        _require_one(self.token, self.app)
        return self
