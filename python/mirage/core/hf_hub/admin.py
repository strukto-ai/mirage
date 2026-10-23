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

from mirage.accessor.hf_hub import HfAccountAccessor
from mirage.core.hf_hub.client import (
    WRITE_RETRY,
    HfHubError,
    hub_get,
    hub_post,
    hub_request,
    repo_url,
    rev_segment,
)
from mirage.core.hf_hub.constants import API_SEGMENTS, HTTP_CONFLICT
from mirage.types import JsonValue


def split_repo_id(repo_id: str) -> tuple[str | None, str]:
    """The organization and name halves the repo endpoints take.

    The create and delete endpoints do not take a `namespace/name` id:
    they take the two apart, and an id with no namespace means the
    caller's own, which the Hub fills in from the token.

    Args:
        repo_id (str): "namespace/name", or a bare name.

    Returns:
        tuple[str | None, str]: the organization and the name.
    """
    if "/" in repo_id:
        organization, name = repo_id.split("/", 1)
        return organization, name
    return None, repo_id


async def create_repo(
    account: HfAccountAccessor,
    repo_id: str,
    repo_type: str = "model",
    private: bool = False,
    space_sdk: str | None = None,
    exist_ok: bool = False,
    resource_group_id: str | None = None,
) -> dict[str, Any]:
    """Create a repository on the Hub.

    Args:
        account (HfAccountAccessor): the install's account.
        repo_id (str): "namespace/name", or a bare name for your own.
        repo_type (str): "model", "dataset" or "space".
        private (bool): whether the repository starts private.
        space_sdk (str | None): the runtime a Space uses, which the Hub
            requires for one and rejects for anything else.
        exist_ok (bool): treat the Hub's 409 as success, answering with
            the repository url derived from the id rather than the one
            the create call would have returned.
        resource_group_id (str | None): the Enterprise resource group to
            create the repository in. Spelled ``resourceGroupId`` on the
            wire, which is huggingface_hub's own spelling for it.

    Returns:
        dict[str, Any]: the decoded response, carrying the repo url.
    """
    organization, name = split_repo_id(repo_id)
    body: dict[str, JsonValue] = {
        "name": name,
        "organization": organization,
        "type": repo_type,
    }
    if private:
        body["visibility"] = "private"
    if space_sdk:
        body["sdk"] = space_sdk
    if resource_group_id:
        body["resourceGroupId"] = resource_group_id
    url = f"{account.endpoint.rstrip('/')}/api/repos/create"
    try:
        data = await hub_post(account, url, body, retry=WRITE_RETRY)
    except HfHubError as err:
        if not exist_ok or err.status != HTTP_CONFLICT:
            raise
        return {"url": repo_url(account.endpoint, repo_type, repo_id)}
    return data if isinstance(data, dict) else {}


def repo_api_url(
    account: HfAccountAccessor, repo_type: str, repo_id: str, suffix: str
) -> str:
    """The /api URL for a repository the CLI named on the line."""
    segment = API_SEGMENTS[repo_type]
    return f"{account.endpoint.rstrip('/')}/api/{segment}/{repo_id}{suffix}"


async def create_tag(
    account: HfAccountAccessor,
    repo_id: str,
    tag: str,
    repo_type: str = "model",
    revision: str = "main",
    message: str | None = None,
) -> None:
    """Tag a revision of a repository.

    Args:
        account (HfAccountAccessor): the install's account.
        repo_id (str): "namespace/name".
        tag (str): the tag to create.
        repo_type (str): "model", "dataset" or "space".
        revision (str): the revision being tagged.
        message (str | None): an annotation for the tag.
    """
    body: dict[str, JsonValue] = {"tag": tag}
    if message is not None:
        body["message"] = message
    url = repo_api_url(
        account, repo_type, repo_id, f"/tag/{rev_segment(revision)}"
    )
    await hub_post(account, url, body, retry=WRITE_RETRY)


async def delete_tag(
    account: HfAccountAccessor,
    repo_id: str,
    tag: str,
    repo_type: str = "model",
) -> None:
    """Remove a tag from a repository.

    Args:
        account (HfAccountAccessor): the install's account.
        repo_id (str): "namespace/name".
        tag (str): the tag to remove.
        repo_type (str): "model", "dataset" or "space".
    """
    url = repo_api_url(account, repo_type, repo_id, f"/tag/{rev_segment(tag)}")
    await hub_request(account, "DELETE", url, None)


async def list_tags(
    account: HfAccountAccessor, repo_id: str, repo_type: str = "model"
) -> list[str]:
    """Every tag on a repository.

    Read from /refs, which is the only endpoint that enumerates them;
    there is no tag listing of its own.

    Args:
        account (HfAccountAccessor): the install's account.
        repo_id (str): "namespace/name".
        repo_type (str): "model", "dataset" or "space".

    Returns:
        list[str]: the tag names, in the Hub's own order.
    """
    url = repo_api_url(account, repo_type, repo_id, "/refs")
    data: JsonValue = await hub_get(account, url)
    rows = data.get("tags") if isinstance(data, dict) else None
    return [
        str(row["name"])
        for row in (rows if isinstance(rows, list) else [])
        if isinstance(row, dict) and "name" in row
    ]
