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

import base64
import json
from dataclasses import dataclass
from typing import Any

from mirage.accessor.hf_hub import HfHubAccessor
from mirage.core.hf_hub.client import (HfHubError, api_url, hub_post,
                                       hub_post_ndjson, rev_segment)
from mirage.core.hf_hub.constants import (COMMIT_CHUNK, DEFAULT_COMMIT_MESSAGE,
                                          PREUPLOAD_SAMPLE_BYTES)
from mirage.types import JsonValue

# The upload modes the Hub's preupload endpoint answers with. "regular"
# is a git blob and rides inline in the commit; the other two are
# out-of-band uploads that must happen BEFORE the commit references them.
REGULAR = "regular"


@dataclass(frozen=True, slots=True)
class Addition:
    """One file a commit adds or replaces.

    Args:
        path (str): repo-relative path.
        data (bytes): the whole content.
    """

    path: str
    data: bytes


class LfsRequiredError(RuntimeError):
    """A write the Hub will only accept through the LFS/Xet upload path.

    Raised rather than papered over, because the alternative is a commit
    that references content the Hub never received: the file would appear
    in the tree and every read of it would fail. Which files land here is
    the repository's own `.gitattributes` plus a size threshold, so it is
    the repo's decision, not a fixed byte count this code could apply.
    """


def commit_url(accessor: HfHubAccessor, revision: str | None = None) -> str:
    """The commit endpoint for one revision.

    Args:
        accessor (HfHubAccessor): the mount's accessor.
        revision (str | None): the revision to commit onto; the mount's
            own when omitted.

    Returns:
        str: the absolute URL.
    """
    rev = revision or accessor.revision
    return api_url(accessor.endpoint, accessor.repo_type, accessor.repo_id,
                   f"/commit/{rev_segment(rev)}")


async def upload_modes(
    accessor: HfHubAccessor,
    additions: list[Addition],
    revision: str | None = None,
) -> dict[str, str]:
    """Ask the Hub how each file must be uploaded.

    The Hub decides regular-vs-LFS-vs-Xet from the repository's
    `.gitattributes` and the file's size, so it is asked rather than
    guessed. It only needs the first bytes to sniff the type, which is
    why a sample rather than the content is sent.

    Args:
        accessor (HfHubAccessor): the mount's accessor.
        additions (list[Addition]): the files about to be committed.
        revision (str | None): the revision being committed onto.

    Returns:
        dict[str, str]: path -> upload mode.
    """
    if not additions:
        return {}
    rev = revision or accessor.revision
    url = api_url(accessor.endpoint, accessor.repo_type, accessor.repo_id,
                  f"/preupload/{rev_segment(rev)}")
    modes: dict[str, str] = {}
    for start in range(0, len(additions), COMMIT_CHUNK):
        chunk = additions[start:start + COMMIT_CHUNK]
        body: JsonValue = {
            "files": [{
                "path":
                add.path,
                "sample":
                base64.b64encode(add.data[:PREUPLOAD_SAMPLE_BYTES]).decode(),
                "size":
                len(add.data),
            } for add in chunk]
        }
        data = await hub_post(accessor.token, url, body, session=accessor.pool)
        rows = data.get("files") if isinstance(data, dict) else None
        for row in rows if isinstance(rows, list) else []:
            if isinstance(row, dict):
                modes[str(row.get("path",
                                  ""))] = str(row.get("uploadMode", REGULAR))
    return modes


def payload(
    additions: list[Addition],
    deletions: list[str],
    folders: list[str],
    message: str,
    description: str = "",
    parent: str = "",
) -> bytes:
    """Serialize one commit as newline-delimited JSON.

    The header line comes first and carries the message; every operation
    is one line after it. This is the Hub's own shape, not a convention
    chosen here.

    Args:
        additions (list[Addition]): files to add or replace.
        deletions (list[str]): file paths to remove.
        folders (list[str]): folder paths to remove, which the Hub
            spells with its own key rather than as a path with a slash.
        message (str): the commit summary.
        description (str): the commit body.
        parent (str): the commit this one must apply onto, for
            optimistic concurrency; omitted when empty.

    Returns:
        bytes: the ndjson body.
    """
    header: dict[str, Any] = {"summary": message, "description": description}
    if parent:
        header["parentCommit"] = parent
    lines: list[dict[str, Any]] = [{"key": "header", "value": header}]
    for add in additions:
        lines.append({
            "key": "file",
            "value": {
                "content": base64.b64encode(add.data).decode(),
                "path": add.path,
                "encoding": "base64",
            },
        })
    for path in deletions:
        lines.append({"key": "deletedFile", "value": {"path": path}})
    for path in folders:
        lines.append({"key": "deletedFolder", "value": {"path": path}})
    return b"".join(json.dumps(line).encode() + b"\n" for line in lines)


async def commit(
    accessor: HfHubAccessor,
    additions: list[Addition] | None = None,
    deletions: list[str] | None = None,
    folders: list[str] | None = None,
    message: str = DEFAULT_COMMIT_MESSAGE,
    description: str = "",
    create_pr: bool = False,
    revision: str | None = None,
) -> dict[str, Any]:
    """Apply one commit to the repository.

    Every addition is checked against the preupload endpoint first, and a
    file the Hub wants uploaded out of band is refused here rather than
    referenced by a commit whose content never arrived.

    Args:
        accessor (HfHubAccessor): the mount's accessor.
        additions (list[Addition] | None): files to add or replace.
        deletions (list[str] | None): file paths to remove.
        folders (list[str] | None): folder paths to remove.
        message (str): the commit summary.
        description (str): the commit body.
        create_pr (bool): open a pull request instead of pushing.
        revision (str | None): the revision to commit onto.

    Returns:
        dict[str, Any]: the Hub's commit response.

    Raises:
        LfsRequiredError: a file must go through the LFS/Xet upload path.
    """
    adds = additions or []
    modes = await upload_modes(accessor, adds, revision)
    heavy = sorted(add.path for add in adds
                   if modes.get(add.path, REGULAR) != REGULAR)
    if heavy:
        raise LfsRequiredError(
            f"{accessor.repo_id}: the Hub requires an LFS upload for "
            f"{', '.join(heavy)}; write it with `hf upload` instead")
    body = payload(adds, deletions or [], folders or [], message, description)
    params = {"create_pr": "1"} if create_pr else None
    data = await hub_post_ndjson(accessor.token,
                                 commit_url(accessor, revision),
                                 body,
                                 params,
                                 session=accessor.pool)
    return data if isinstance(data, dict) else {}


def is_absent(exc: HfHubError) -> bool:
    """Whether a failed commit failed because the target was not there.

    Args:
        exc (HfHubError): the error the Hub answered with.

    Returns:
        bool: True when the status says the path or repo is missing.
    """
    return exc.status == 404
