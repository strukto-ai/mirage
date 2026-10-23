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

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator

from mirage.utils import key_prefix as kp
from mirage.vfs.constants import FULL_SCAN_LIMIT


class HfBucketsConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    bucket: str
    """Bucket id in `namespace/name` form."""
    token: SecretStr | None = None
    """Hugging Face access token."""
    endpoint: str = "https://huggingface.co"
    """Hub origin requests go to, for a mirror or a self-hosted Hub."""
    timeout: int = 30
    """Seconds one Hub request may go without progress: connecting, waiting
    for the answer, or between two chunks of a download. `0` turns the bound
    off."""
    key_prefix: str | None = None
    """Path inside the bucket that becomes the mount root; files outside it
    are not listed."""
    full_scan_limit: int = Field(default=FULL_SCAN_LIMIT, ge=-1)
    """Most files one command walks under a folder: `grep -r`, `find` and other
    walks stop there, and a larger glob, `tar -c`, `cp -r` or `rm -r` is
    refused. `-1` lifts the limit."""

    @field_validator("bucket")
    @classmethod
    def _validate_bucket(cls, v: str) -> str:
        parts = v.split("/")
        if len(parts) != 2 or not parts[0] or not parts[1]:
            raise ValueError(
                f"bucket must be in 'namespace/name' form; got {v!r}"
            )
        return v

    @field_validator("key_prefix")
    @classmethod
    def _normalize_key_prefix(cls, v: str | None) -> str | None:
        return kp.normalize(v) or None


class HfRepoConfig(BaseModel):
    """What a Hub repository mount is configured with.

    One shape for all three repo kinds, because the Hub's own API differs
    between them only by a URL segment. The kind is the accessor's, not
    the config's, so `repo_type` is not a field a caller can set to a
    value the VFS disagrees with.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    repo_id: str
    """Repository id as `namespace/name`, or a bare `name` that resolves
    against the token's owner."""
    token: SecretStr | None = None
    """Hugging Face access token; unset sends anonymous requests, which
    reach public repositories only."""
    endpoint: str = "https://huggingface.co"
    """Hub origin requests go to, for a mirror or a self-hosted Hub."""
    timeout: int = 30
    """Seconds one Hub request may go without progress: connecting, waiting
    for the answer, or between two chunks of a download. `0` turns the bound
    off."""
    key_prefix: str | None = None
    """Path inside the repository that becomes the mount root; files outside
    it are not listed."""
    revision: str | None = None
    """Branch, tag or commit the mount reads; unset reads `main`."""
    expand_commits: bool | None = None
    """Fetch each file's last commit so listings carry modification times, at
    50 entries per request instead of 1000. Unset does so only when the
    whole repository fits in one page."""
    full_scan_limit: int = Field(default=FULL_SCAN_LIMIT, ge=-1)
    """Most files one command walks under a folder: `grep -r`, `find` and other
    walks stop there, and a larger glob, `tar -c`, `cp -r` or `rm -r` is
    refused. `-1` lifts the limit."""

    @field_validator("repo_id")
    @classmethod
    def _validate_repo_id(cls, v: str) -> str:
        """Either spelling the Hub itself accepts.

        A repo id is ``namespace/name`` or a bare ``name``, and the
        second resolves against whoever the token belongs to. That is
        not a convenience: ``hf repo create widget`` followed by
        ``hf download widget`` is what the real CLI produces, and
        refusing the bare form made mirage reject an id the Hub had
        just minted. What is refused is a shape the Hub has no reading
        for: an empty segment, or more than one slash.
        """
        parts = v.split("/")
        if len(parts) > 2 or any(not part for part in parts):
            raise ValueError(
                f"repo_id must be 'name' or 'namespace/name'; got {v!r}"
            )
        return v

    @field_validator("key_prefix")
    @classmethod
    def _normalize_key_prefix(cls, v: str | None) -> str | None:
        return kp.normalize(v) or None
