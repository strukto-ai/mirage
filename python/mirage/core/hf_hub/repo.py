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

from enum import Enum
from typing import Any

from mirage.accessor.hf_hub import HfHubAccessor
from mirage.core.hf_hub.client import HfHubError, api_url, hub_get, rev_segment
from mirage.types import JsonValue


class Absence(Enum):
    """What the Hub says is missing when a listing came back empty."""

    PRESENT = "present"
    REPO = "repo"
    REVISION = "revision"


async def fetch_refs(accessor: HfHubAccessor) -> dict[str, Any]:
    """The repository's branches, tags and conversion refs.

    Args:
        accessor (HfHubAccessor): the mount's accessor.

    Returns:
        dict[str, Any]: the decoded /refs object.
    """
    url = api_url(accessor.endpoint, accessor.repo_type, accessor.repo_id,
                  "/refs")
    data: JsonValue = await hub_get(accessor.token, url, session=accessor.pool)
    return data if isinstance(data, dict) else {}


async def head_commit(accessor: HfHubAccessor) -> str:
    """The commit the mount's revision currently points at.

    Read from the repo object rather than from /refs because the repo
    object answers it for a tag and a commit-pinned mount too, where
    /refs only enumerates branches.

    Asked of the revision endpoint, not the bare one: the bare object's
    `sha` is the default branch's whatever revision was requested, and
    the cache is keyed by this sha. Reading the wrong one files a
    `--revision dev` download under main's snapshot and points refs/dev
    at it, so a later main download finds the snapshot already there and
    serves dev's bytes.

    Args:
        accessor (HfHubAccessor): the mount's accessor.

    Returns:
        str: the commit sha, or "" when the Hub reported none.
    """
    data: JsonValue = await hub_get(accessor.token,
                                    revision_url(accessor),
                                    session=accessor.pool)
    if not isinstance(data, dict):
        return ""
    sha = data.get("sha")
    return sha if isinstance(sha, str) else ""


async def classify_absence(accessor: HfHubAccessor) -> Absence:
    """Why a listing came back empty, asked of the Hub directly.

    ``fetch_tree`` folds 401/403/404 into an empty listing on purpose: a
    mount's readdir over a repository it cannot see has to render an
    empty directory rather than raise. A CLI verb wants the opposite, so
    it asks this on the failure path only, which costs one request and
    only when something already went wrong.

    The status cannot answer it. A missing repository, a missing
    revision and a missing file are all 404, and only the Hub's
    ``X-Error-Code`` header tells them apart; probed against the live
    Hub, not inferred.

    Args:
        accessor (HfHubAccessor): the Hub handle naming the repository
            and revision.

    Returns:
        Absence: which of the two the Hub reports, PRESENT when the
        revision resolves and the empty listing means an empty subtree.
    """
    try:
        await hub_get(accessor.token,
                      revision_url(accessor),
                      session=accessor.pool)
    except HfHubError as exc:
        if exc.error_code == "RepoNotFound":
            return Absence.REPO
        if exc.error_code == "RevisionNotFound":
            return Absence.REVISION
        raise
    return Absence.PRESENT


def revision_url(accessor: HfHubAccessor) -> str:
    """The endpoint whose url upstream names in its not-found messages.

    Args:
        accessor (HfHubAccessor): the Hub handle.

    Returns:
        str: the absolute ``/api/<kind>s/<id>/revision/<rev>`` url.
    """
    return api_url(accessor.endpoint, accessor.repo_type, accessor.repo_id,
                   f"/revision/{rev_segment(accessor.revision)}")
