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

import aiohttp
from pydantic import SecretStr

from mirage.accessor.base import Accessor, SessionAccessor
from mirage.core.hf_hub.config import HfConfig
from mirage.core.hf_hub.constants import DEFAULT_REVISION
from mirage.utils import key_prefix as kp
from mirage.vfs.hf_buckets.config import HfBucketsConfig, HfRepoConfig


def stall_timeout(seconds: float) -> aiohttp.ClientTimeout:
    """How long a Hub request may go without progress.

    The clock restarts on every body chunk, so a download that keeps
    flowing is never cut off. Zero or less is no bound: a negative read
    bound would fire at once.

    Args:
        seconds (float): the configured timeout.

    Returns:
        aiohttp.ClientTimeout: the bound, for the account's pool.
    """
    if seconds <= 0:
        return aiohttp.ClientTimeout(total=None)
    return aiohttp.ClientTimeout(
        total=None, sock_connect=seconds, sock_read=seconds
    )


class HfAccountAccessor(SessionAccessor):
    """One Hub account: credential, origin and the pool its calls ride.

    The `hf` CLI's install accessor and the account a repository handle
    borrows; a mount builds its own with `account_of`.

    Args:
        config (HfConfig): the token and the Hub origin.
        timeout (float): seconds one request may go without progress.
    """

    def __init__(self, config: HfConfig, timeout: float = 30) -> None:
        # aiohttp's own replay of a dropped PUT or DELETE would run beneath
        # RETRY and WRITE_RETRY; the policies decide every resend.
        super().__init__(
            timeout=stall_timeout(timeout), retry_connection=False
        )
        self.config = config

    @property
    def token(self) -> SecretStr | None:
        return self.config.token

    @property
    def endpoint(self) -> str:
        return self.config.endpoint


def account_of(config: HfRepoConfig | HfBucketsConfig) -> HfAccountAccessor:
    """The account a repository or bucket mount builds and owns.

    Args:
        config (HfRepoConfig | HfBucketsConfig): the mount's config.

    Returns:
        HfAccountAccessor: an account no other handle shares.
    """
    return HfAccountAccessor(
        HfConfig(token=config.token, endpoint=config.endpoint),
        timeout=config.timeout,
    )


class HfHubAccessor(Accessor):
    """One Hugging Face Hub repository, over an account it never closes.

    The Hub's listing endpoint is recursive, so one paged walk is the
    mount's entire listing, which the mount keeps; every stat and read
    after it is handed its row.

    Constructed without touching the network. A constructor cannot await,
    so fetching here would mean a blocking client stalling whatever loop
    the caller is on.
    """

    REPO_TYPE: str = ""
    VFS_NAME: str = ""

    def __init__(
        self,
        account: HfAccountAccessor,
        config: HfRepoConfig,
        repo_type: str = "",
    ) -> None:
        """Args:
        account (HfAccountAccessor): the account every call rides.
        config (HfRepoConfig): repo id, revision, key prefix and listing mode.
        repo_type (str): overrides the class's own kind, for a caller
            that learns it from a command line rather than from
            which VFS it mounted. The `hf` CLI is the only one:
            its `--repo-type` picks the kind per invocation, and
            letting it build an accessor is what lets the CLI reuse
            the mount's tree and commit code instead of growing a
            second Hub client.
        """
        self.account = account
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
        return self.account.endpoint

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


def hub_for(
    account: HfAccountAccessor,
    repo_id: str,
    repo_type: str,
    revision: str | None = None,
) -> HfHubAccessor:
    """A Hub handle for one repository, over an account it borrows.

    The `hf` CLI builds one per invocation over the install's account
    rather than owning a second Hub client: the handle only names which
    repository is being addressed and rides the account's credential,
    origin and pool, so `hf` gets the mount's tree walk and commit
    builder for free and one install keeps one pool. It reaches no
    mount, which is what keeps `hf` an account CLI. A verb reads paths
    and sizes, never the per-file commit a mount's mtimes come from, so
    the walk lists bare.

    Args:
        account (HfAccountAccessor): the install's account.
        repo_id (str): "namespace/name".
        repo_type (str): "model", "dataset" or "space".
        revision (str | None): the revision to read or write.

    Returns:
        HfHubAccessor: the handle, which borrows the account and needs
        no close.
    """
    repo = HfRepoConfig(
        repo_id=repo_id,
        revision=revision or DEFAULT_REVISION,
        expand_commits=False,
    )
    return HfHubAccessor(account, repo, repo_type=repo_type)


class HfModelsAccessor(HfHubAccessor):
    REPO_TYPE = "model"
    VFS_NAME = "hf_models"


class HfDatasetsAccessor(HfHubAccessor):
    REPO_TYPE = "dataset"
    VFS_NAME = "hf_datasets"


class HfSpacesAccessor(HfHubAccessor):
    REPO_TYPE = "space"
    VFS_NAME = "hf_spaces"
