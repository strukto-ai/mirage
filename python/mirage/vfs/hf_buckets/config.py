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

from pydantic import BaseModel, ConfigDict, SecretStr, field_validator

from mirage.utils import key_prefix as kp


class HfBucketsConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    bucket: str
    token: SecretStr | None = None
    endpoint: str = "https://huggingface.co"
    timeout: int = 30
    key_prefix: str | None = None

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
    token: SecretStr | None = None
    endpoint: str = "https://huggingface.co"
    timeout: int = 30
    key_prefix: str | None = None
    revision: str | None = None
    # Whether the listing asks the Hub for each path's last commit, which
    # is a Hub file's only source of an mtime and drops the tree page
    # from 1000 rows to 50. None is the default and means decide by size:
    # ask for one expanded page, and keep it if the whole repository fit
    # in it, otherwise re-walk bare. A small repo therefore gets mtimes
    # for the same one request it would have cost without them, and a
    # sharded dataset pays one wasted page rather than a twentyfold walk.
    # True and False force it either way.
    expand_commits: bool | None = None

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
