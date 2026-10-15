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

from pydantic import SecretStr

from mirage.accessor.base import SessionAccessor
from mirage.core.hf_hub.client import stall_timeout
from mirage.core.hf_hub.constants import DEFAULT_REVISION
from mirage.utils import key_prefix as kp
from mirage.vfs.hf_buckets.config import HfRepoConfig


class HfHubAccessor(SessionAccessor):
    """A mount onto one Hugging Face Hub repository.

    The Hub's listing endpoint is recursive, so one paged walk is the
    mount's entire listing, which the mount keeps; every stat and read
    after it is handed its row.

    Constructed without touching the network. A constructor cannot await,
    so fetching here would mean a blocking client stalling whatever loop
    the caller is on.
    """

    REPO_TYPE: str = ""
    VFS_NAME: str = ""

    def __init__(self, config: HfRepoConfig, repo_type: str = "") -> None:
        """Args:
        config (HfRepoConfig): repo id, credential and revision.
        repo_type (str): overrides the class's own kind, for a caller
            that learns it from a command line rather than from
            which VFS it mounted. The `hf` CLI is the only one:
            its `--repo-type` picks the kind per invocation, and
            letting it build an accessor is what lets the CLI reuse
            the mount's tree and commit code instead of growing a
            second Hub client.
        """
        super().__init__(timeout=stall_timeout(config.timeout))
        self.config = config
        self._repo_type = repo_type or self.REPO_TYPE

    @property
    def repo_type(self) -> str:
        return self._repo_type

    @property
    def repo_id(self) -> str:
        return self.config.repo_id

    @property
    def endpoint(self) -> str:
        return self.config.endpoint

    @property
    def token(self) -> SecretStr | None:
        return self.config.token

    @property
    def revision(self) -> str:
        """The revision this mount reads.

        Resolved without a request, unlike GitHub's default branch: the
        Hub creates every repository with `main` and offers no way to
        change which branch is default, so naming no revision means that
        branch and nothing has to be asked.
        """
        return self.config.revision or DEFAULT_REVISION

    @property
    def key_prefix(self) -> str:
        return self.config.key_prefix or ""

    @property
    def expand_commits(self) -> bool | None:
        return self.config.expand_commits

    @property
    def bucket_uri(self) -> str:
        return f"hf://{self.repo_type}s/{self.config.repo_id}"

    def repo_path(self, rel: str) -> str:
        """Lift a mount-relative path to its repo-relative spelling.

        Args:
            rel (str): the path as the mount sees it.

        Returns:
            str: the path the Hub knows it by.
        """
        prefix = self.key_prefix
        if not prefix:
            return rel.strip("/")
        # `key_prefix` is normalized with a TRAILING slash, so joining
        # with one of our own produced `sub/dir//a.txt` and every read of
        # a prefixed mount 404'd.
        return (
            kp.apply(prefix, rel).rstrip("/")
            if rel.strip("/")
            else prefix.rstrip("/")
        )


class HfModelsAccessor(HfHubAccessor):
    REPO_TYPE = "model"
    VFS_NAME = "hf_models"


class HfDatasetsAccessor(HfHubAccessor):
    REPO_TYPE = "dataset"
    VFS_NAME = "hf_datasets"


class HfSpacesAccessor(HfHubAccessor):
    REPO_TYPE = "space"
    VFS_NAME = "hf_spaces"
