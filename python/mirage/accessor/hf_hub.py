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

import asyncio

from pydantic import BaseModel, ConfigDict, SecretStr, field_validator

from mirage.accessor.base import SessionAccessor
from mirage.cache.index import IndexEntry
from mirage.core.hf_hub.constants import DEFAULT_REVISION
from mirage.core.hf_hub.tree_entry import TreeEntry
from mirage.utils import key_prefix as kp


class HfRepoConfig(BaseModel):
    """What a Hub repository mount is configured with.

    One shape for all three repo kinds, because the Hub's own API differs
    between them only by a URL segment. The kind is the accessor's, not
    the config's, so `repo_type` is not a field a caller can set to a
    value the resource disagrees with.
    """

    model_config = ConfigDict(frozen=True)

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
                f"repo_id must be 'name' or 'namespace/name'; got {v!r}")
        return v

    @field_validator("key_prefix")
    @classmethod
    def _normalize_key_prefix(cls, v: str | None) -> str | None:
        return kp.normalize(v) or None

    @property
    def namespace(self) -> str:
        """The owner half, "" when the id leaves it to the token."""
        parts = self.repo_id.split("/", 1)
        return parts[0] if len(parts) == 2 else ""

    @property
    def repo_name(self) -> str:
        parts = self.repo_id.split("/", 1)
        return parts[1] if len(parts) == 2 else parts[0]


class HfHubAccessor(SessionAccessor):
    """A mount onto one Hugging Face Hub repository.

    Holds the whole repository tree, the way GitHubAccessor holds a git
    tree: the Hub's listing endpoint is recursive, so one paged walk is
    the mount's entire listing and every read after it is a lookup. Find
    and du read that tree directly; everything else goes through the
    index it seeds.

    Constructed without touching the network. A constructor cannot await,
    so fetching here would mean a blocking client stalling whatever loop
    the caller is on; the tree hydrates on first use instead.
    """

    REPO_TYPE: str = ""
    RESOURCE_NAME: str = ""

    def __init__(self, config: HfRepoConfig, repo_type: str = "") -> None:
        """Args:
            config (HfRepoConfig): repo id, credential and revision.
            repo_type (str): overrides the class's own kind, for a caller
                that learns it from a command line rather than from
                which resource it mounted. The `hf` CLI is the only one:
                its `--repo-type` picks the kind per invocation, and
                letting it build an accessor is what lets the CLI reuse
                the mount's tree and commit code instead of growing a
                second Hub client.
        """
        super().__init__()
        self.config = config
        self._repo_type = repo_type or self.REPO_TYPE
        # Guards the lazy hydration so concurrent first reads make one
        # request rather than one per caller. Constructed outside a
        # running loop on purpose; asyncio.Lock has not bound to a loop
        # at construction since 3.10.
        self.tree_lock = asyncio.Lock()
        # The recursive tree, keyed mount-relative with no leading slash
        # and with key_prefix already stripped. Reseated by every refill.
        self.tree: dict[str, TreeEntry] = {}
        # Whether that tree is an answer or just the empty default, which
        # is a different question from whether it holds anything: an
        # empty repository hydrates to {}, and reading that as "not
        # hydrated" refetches it forever.
        self.tree_loaded: bool = False
        # The index tables derived from that tree, for a mount with no
        # index wired. Derivation is O(tree), so a readdir loop over a
        # large repo would be quadratic without a memo; every reseat of
        # `tree` clears it.
        self.rows_cache: tuple[str, dict[str, IndexEntry],
                               dict[str, list[str]]] | None = None

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
        return kp.apply(prefix, rel).rstrip("/") if rel.strip("/") \
            else prefix.rstrip("/")
