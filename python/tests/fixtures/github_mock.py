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

import hashlib
import logging
from dataclasses import dataclass, field
from typing import Any

import pytest
from pydantic import SecretStr

from mirage.core.github.config import GitHubConfig
from mirage.core.github.search import SearchResult
from mirage.core.github.tree_entry import TreeEntry

logger = logging.getLogger(__name__)

MOCK_TREE = {
    "README.md": TreeEntry(
        path="README.md", type="blob", sha="aaa111", size=500
    ),
    "pyproject.toml": TreeEntry(
        path="pyproject.toml", type="blob", sha="aaa222", size=1200
    ),
    "src": TreeEntry(path="src", type="tree", sha="bbb000", size=None),
    "src/__init__.py": TreeEntry(
        path="src/__init__.py", type="blob", sha="bbb111", size=0
    ),
    "src/main.py": TreeEntry(
        path="src/main.py", type="blob", sha="bbb222", size=3400
    ),
    "src/utils.py": TreeEntry(
        path="src/utils.py", type="blob", sha="bbb333", size=1800
    ),
    "src/config.py": TreeEntry(
        path="src/config.py", type="blob", sha="bbb444", size=900
    ),
    "src/models": TreeEntry(
        path="src/models", type="tree", sha="ccc000", size=None
    ),
    "src/models/__init__.py": TreeEntry(
        path="src/models/__init__.py", type="blob", sha="ccc111", size=0
    ),
    "src/models/user.py": TreeEntry(
        path="src/models/user.py", type="blob", sha="ccc222", size=2100
    ),
    "src/models/item.py": TreeEntry(
        path="src/models/item.py", type="blob", sha="ccc333", size=1500
    ),
    "tests": TreeEntry(path="tests", type="tree", sha="ddd000", size=None),
    "tests/test_main.py": TreeEntry(
        path="tests/test_main.py", type="blob", sha="ddd111", size=4200
    ),
    "tests/test_utils.py": TreeEntry(
        path="tests/test_utils.py", type="blob", sha="ddd222", size=2800
    ),
    "docs": TreeEntry(path="docs", type="tree", sha="eee000", size=None),
    "docs/guide.md": TreeEntry(
        path="docs/guide.md", type="blob", sha="eee111", size=8500
    ),
}

MOCK_BLOBS = {
    "aaa111": b"# Mock Repo\n\nA test repository.\n",
    "aaa222": b'[project]\nname = "mock-repo"\nversion = "0.1.0"\n',
    "bbb111": b"",
    "bbb222": (
        b"import os\nimport sys\n"
        b"from src.utils import helper\n"
        b"\nasync def main():\n    pass\n"
    ),
    "bbb333": b"import json\n\ndef helper():\n    return 42\n",
    "bbb444": b'DB_URL = "localhost"\nDEBUG = True\n',
    "ccc111": b"",
    "ccc222": (
        b"from dataclasses import dataclass\n\n"
        b"@dataclass\nclass User:\n"
        b"    name: str\n    email: str\n"
    ),
    "ccc333": (
        b"from dataclasses import dataclass\n\n"
        b"@dataclass\nclass Item:\n"
        b"    title: str\n    price: float\n"
    ),
    "ddd111": (
        b"import pytest\nfrom src.main import main\n"
        b"\nasync def test_main():\n    assert True\n"
    ),
    "ddd222": (
        b"import pytest\nfrom src.utils import helper\n"
        b"\ndef test_helper():\n"
        b"    assert helper() == 42\n"
    ),
    "eee111": b"# User Guide\n\nThis is the user guide for the mock repo.\n",
}

MOCK_DEFAULT_BRANCH = "main"

MOCK_SEARCH_RESULTS = {
    "import": [
        SearchResult(path="src/main.py", sha="bbb222"),
        SearchResult(path="src/utils.py", sha="bbb333"),
        SearchResult(path="src/models/user.py", sha="ccc222"),
        SearchResult(path="src/models/item.py", sha="ccc333"),
        SearchResult(path="tests/test_main.py", sha="ddd111"),
        SearchResult(path="tests/test_utils.py", sha="ddd222"),
    ],
    "dataclass": [
        SearchResult(path="src/models/user.py", sha="ccc222"),
        SearchResult(path="src/models/item.py", sha="ccc333"),
    ],
}


@dataclass
class FakeGitHubApi:
    """In-memory GitHub API fake simulating repository data and operations.

    Args:
        tree (dict[str, Any]): path to TreeEntry map.
        blobs (dict[str, bytes]): sha to blob bytes map.
        default_branch (str): default branch name.
        search_results (dict[str, list[SearchResult]]): query to search results map.
    """

    tree: dict[str, Any] = field(default_factory=lambda: dict(MOCK_TREE))
    blobs: dict[str, bytes] = field(default_factory=lambda: dict(MOCK_BLOBS))
    default_branch: str = MOCK_DEFAULT_BRANCH
    search_results: dict[str, list[SearchResult]] = field(
        default_factory=lambda: dict(MOCK_SEARCH_RESULTS)
    )

    def __post_init__(self) -> None:
        old_to_real: dict[str, str] = {}
        new_blobs = dict(self.blobs)
        for old_sha, content in list(self.blobs.items()):
            real_sha = hashlib.sha1(
                f"blob {len(content)}\0".encode() + content
            ).hexdigest()
            new_blobs[real_sha] = content
            old_to_real[old_sha] = real_sha
        self.blobs = new_blobs

        self.tree = {
            path: TreeEntry(
                path=entry.path,
                type=entry.type,
                sha=old_to_real.get(entry.sha, entry.sha),
                size=(
                    len(self.blobs[old_to_real[entry.sha]])
                    if entry.type == "blob" and entry.sha in old_to_real
                    else entry.size
                ),
            )
            for path, entry in self.tree.items()
        }

        new_search: dict[str, list[SearchResult]] = {}
        for q, results in self.search_results.items():
            new_search[q] = [
                SearchResult(path=r.path, sha=old_to_real.get(r.sha, r.sha))
                for r in results
            ]
        self.search_results = new_search

    def head(self) -> str:
        """The repository's head: a digest of its tree, so any edit to
        ``tree`` moves it."""
        state = "".join(
            f"{path}\0{entry.type}\0{entry.sha}\n"
            for path, entry in sorted(self.tree.items())
        )
        return hashlib.sha1(state.encode()).hexdigest()

    async def fetch_default_branch(
        self, account: Any, owner: str, repo: str
    ) -> str:
        return self.default_branch

    async def fetch_tree(
        self, account: Any, owner: str, repo: str, ref: str
    ) -> tuple[dict[str, Any], bool, Any]:
        return dict(self.tree), False, self.head()

    async def fetch_head(
        self, account: Any, owner: str, repo: str, ref: str
    ) -> str | None:
        return self.head()

    async def fetch_dir_page(
        self, account: Any, owner: str, repo: str, tree_sha: str
    ) -> tuple[list[TreeEntry], bool]:
        if ":" in tree_sha:
            dir_path = tree_sha.split(":", 1)[1].strip("/")
        else:
            matching = [
                entry.path
                for entry in self.tree.values()
                if entry.type == "tree" and entry.sha == tree_sha
            ]
            dir_path = matching[0] if matching else ""

        results: list[TreeEntry] = []
        if not dir_path:
            for p, entry in self.tree.items():
                if "/" not in p:
                    results.append(
                        TreeEntry(
                            path=p,
                            type=entry.type,
                            sha=entry.sha,
                            size=entry.size,
                        )
                    )
        else:
            prefix = dir_path + "/"
            for p, entry in self.tree.items():
                if p.startswith(prefix):
                    rest = p[len(prefix) :]
                    if "/" not in rest:
                        results.append(
                            TreeEntry(
                                path=rest,
                                type=entry.type,
                                sha=entry.sha,
                                size=entry.size,
                            )
                        )
        return results, False

    async def read_bytes(
        self, account: Any, owner: str, repo: str, sha: str
    ) -> bytes:
        return self.blobs[sha]

    async def search_code(
        self,
        account: Any,
        owner: str,
        repo: str,
        query: str,
        path_filter: str | None = None,
    ) -> tuple[list[SearchResult], bool]:
        results = self.search_results.get(query, [])
        if path_filter:
            results = [r for r in results if r.path.startswith(path_filter)]
        return list(results), False

    async def graphql_data(
        self, account: Any, query: str, variables: dict[str, Any]
    ) -> dict[str, Any]:
        repo_res: dict[str, Any] = {}
        for k, v in variables.items():
            if k in ("owner", "repo"):
                continue
            sha = str(v)
            raw = self.blobs.get(sha, b"")
            try:
                text = raw.decode("utf-8")
                repo_res[k] = {"text": text, "isTruncated": False}
            except UnicodeDecodeError as exc:
                logger.debug(
                    "Skipping binary or non-utf8 blob %s: %s", sha, exc
                )
        return {"repository": repo_res}


@pytest.fixture
def github_config() -> GitHubConfig:
    return GitHubConfig(token=SecretStr("ghp_mock_token"))


@pytest.fixture
def mock_github_api(monkeypatch: pytest.MonkeyPatch) -> FakeGitHubApi:
    api = FakeGitHubApi()
    # Both are patched in the module that fetches, because the mount is
    # built without touching the network and hydrates on first use:
    # `refresh_tree` calls fetch_tree in tree.py, and
    # `ensure_default_branch` calls fetch_default_branch in repo.py.
    monkeypatch.setattr(
        "mirage.core.github.repo.fetch_default_branch",
        api.fetch_default_branch,
    )
    monkeypatch.setattr("mirage.core.github.tree.fetch_tree", api.fetch_tree)
    monkeypatch.setattr(
        "mirage.core.github.tree.fetch_head",
        api.fetch_head,
    )
    monkeypatch.setattr(
        "mirage.core.github.stat.fetch_head",
        api.fetch_head,
    )
    monkeypatch.setattr(
        "mirage.core.github.readdir.fetch_head",
        api.fetch_head,
    )
    monkeypatch.setattr(
        "mirage.core.github.tree.fetch_dir_page",
        api.fetch_dir_page,
    )
    monkeypatch.setattr("mirage.core.github.read.read_bytes", api.read_bytes)
    monkeypatch.setattr(
        "mirage.core.github.search.search_code", api.search_code
    )
    return api
