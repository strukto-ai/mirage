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

from mirage.accessor.hf_hub import HfHubAccessor
from mirage.core.hf_hub.client import HfHubError, api_url, hub_get, rev_segment
from mirage.types import JsonValue


class Absence(Enum):
    """What the Hub says is missing when a listing came back empty."""

    PRESENT = "present"
    REPO = "repo"
    REVISION = "revision"


def mount_version(head: str | None, key_prefix: str) -> str | None:
    """The version a mount's listings are stored and checked at.

    The head commit, joined with the key prefix when the mount has one: the
    index keys are mount-relative, so two mounts of one repository at one
    head but different key prefixes hold different listings under the same
    keys, and must not match each other's version. ":" cannot occur in a
    hex sha, and a mount with no key prefix keeps the plain head.

    Args:
        head (str | None): the head commit, or None when none is known.
        key_prefix (str): the mount's normalized key prefix, "" for none.

    Returns:
        str | None: the version, or None when the head is unknown.
    """
    if not head:
        return None
    return f"{head}:{key_prefix}" if key_prefix else head


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
    # Only the sha is read, so only the sha is asked for: the bare object
    # lists every file (1.5 MB on a large dataset), the trimmed one is about
    # 110 bytes. A param, never part of revision_url, which every not-found
    # message names verbatim.
    data: JsonValue = await hub_get(
        accessor.account, revision_url(accessor), {"expand[]": "sha"}
    )
    if not isinstance(data, dict):
        return ""
    sha = data.get("sha")
    return sha if isinstance(sha, str) else ""


async def classify_absence(accessor: HfHubAccessor) -> Absence:
    """Why a listing came back empty, asked of the Hub directly.

    ``hf download`` folds a tree walk the Hub refused (401/403/404) into
    an empty listing itself, so its failure path can name the absence
    upstream would. It asks this on that path only, which costs one
    request and only when something already went wrong.

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
        await hub_get(accessor.account, revision_url(accessor))
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
    return api_url(
        accessor.endpoint,
        accessor.repo_type,
        accessor.repo_id,
        f"/revision/{rev_segment(accessor.revision)}",
    )
