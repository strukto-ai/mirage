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
from urllib.parse import quote

from mirage.accessor.github import GitHubAccount
from mirage.core.github.client import GitHubApiError, github_request
from mirage.core.github.paginate import github_pages
from mirage.core.github.repo import RepoRef
from mirage.types import JsonValue


def _path(ref: RepoRef, tail: str = "") -> str:
    return f"/repos/{ref.owner}/{ref.repo}/releases{tail}"


async def list_releases(
    account: GitHubAccount, ref: RepoRef, limit: int
) -> list[dict[str, Any]]:
    return await github_pages(account, _path(ref), limit=limit)


async def get_release(
    account: GitHubAccount, ref: RepoRef, tag: str
) -> JsonValue:
    return await github_request(
        account, "GET", _path(ref, f"/tags/{quote(tag, safe='')}")
    )


async def get_latest_release(
    account: GitHubAccount, ref: RepoRef
) -> "JsonValue | None":
    try:
        return await github_request(account, "GET", _path(ref, "/latest"))
    except GitHubApiError as exc:
        if exc.status == 404:
            return None
        raise


async def create_release(
    account: GitHubAccount, ref: RepoRef, body: dict[str, JsonValue]
) -> JsonValue:
    return await github_request(account, "POST", _path(ref), body)
