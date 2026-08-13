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

from dataclasses import dataclass

from mirage.core.github._client import github_get, github_request
from mirage.core.github.config import GhConfig, GitHubConfig
from mirage.types import JsonValue


@dataclass(frozen=True, slots=True)
class RepoRef:
    owner: str
    repo: str


async def fetch_default_branch(config: GitHubConfig, owner: str,
                               repo: str) -> str:
    data = await github_get(config.token,
                            "/repos/{owner}/{repo}",
                            base_url=config.base_url,
                            owner=owner,
                            repo=repo)
    return data["default_branch"]


def parse_repo(spec: str) -> RepoRef:
    """Split gh's `[HOST/]OWNER/REPO`.

    The host is optional and leading, so the owner and the repository are
    always the last two segments. Taking the first two instead reads
    `github.com/acme/tools` as owner `github.com`, repo `acme` -- a
    different repository, reported as success.

    Args:
        spec (str): the repository as the line spelled it.

    Returns:
        RepoRef: the owner and repository names.

    Raises:
        ValueError: the spec is not one or two slashes of names.
    """
    parts = spec.split("/")
    # One extra segment is a host; two is not a repository any spelling
    # of gh's format reaches.
    if len(parts) not in (2, 3) or not all(parts[-2:]):
        raise ValueError(
            f'expected the "[HOST/]OWNER/REPO" format, got "{spec}"')
    return RepoRef(owner=parts[-2], repo=parts[-1])


async def login(config: GhConfig) -> str:
    """The authenticated account's login name.

    Args:
        config (GhConfig): the install's configuration.

    Returns:
        str: the login, empty when the account reports none.
    """
    me = await github_request(config.token,
                              "GET",
                              "/user",
                              base_url=config.base_url)
    name = me.get("login") if isinstance(me, dict) else None
    return name if isinstance(name, str) else ""


async def view_repo(config: GhConfig, ref: RepoRef) -> JsonValue:
    return await github_request(config.token,
                                "GET",
                                f"/repos/{ref.owner}/{ref.repo}",
                                base_url=config.base_url)


async def fork_repo(config: GhConfig,
                    ref: RepoRef,
                    name: str | None = None) -> JsonValue:
    body: JsonValue = {} if name is None else {"name": name}
    return await github_request(config.token,
                                "POST",
                                f"/repos/{ref.owner}/{ref.repo}/forks",
                                body,
                                base_url=config.base_url)


async def rename_repo(config: GhConfig, ref: RepoRef, name: str) -> JsonValue:
    return await github_request(config.token,
                                "PATCH",
                                f"/repos/{ref.owner}/{ref.repo}",
                                {"name": name},
                                base_url=config.base_url)
