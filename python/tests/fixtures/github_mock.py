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

import pytest

from mirage.core.github.config import GitHubConfig
from mirage.core.github.search import SearchResult
from mirage.core.github.tree_entry import TreeEntry

MOCK_TREE = {
    "README.md":
    TreeEntry(path="README.md", type="blob", sha="aaa111", size=500),
    "pyproject.toml":
    TreeEntry(path="pyproject.toml", type="blob", sha="aaa222", size=1200),
    "src":
    TreeEntry(path="src", type="tree", sha="bbb000", size=None),
    "src/__init__.py":
    TreeEntry(path="src/__init__.py", type="blob", sha="bbb111", size=0),
    "src/main.py":
    TreeEntry(path="src/main.py", type="blob", sha="bbb222", size=3400),
    "src/utils.py":
    TreeEntry(path="src/utils.py", type="blob", sha="bbb333", size=1800),
    "src/config.py":
    TreeEntry(path="src/config.py", type="blob", sha="bbb444", size=900),
    "src/models":
    TreeEntry(path="src/models", type="tree", sha="ccc000", size=None),
    "src/models/__init__.py":
    TreeEntry(path="src/models/__init__.py", type="blob", sha="ccc111",
              size=0),
    "src/models/user.py":
    TreeEntry(path="src/models/user.py", type="blob", sha="ccc222", size=2100),
    "src/models/item.py":
    TreeEntry(path="src/models/item.py", type="blob", sha="ccc333", size=1500),
    "tests":
    TreeEntry(path="tests", type="tree", sha="ddd000", size=None),
    "tests/test_main.py":
    TreeEntry(path="tests/test_main.py", type="blob", sha="ddd111", size=4200),
    "tests/test_utils.py":
    TreeEntry(path="tests/test_utils.py", type="blob", sha="ddd222",
              size=2800),
    "docs":
    TreeEntry(path="docs", type="tree", sha="eee000", size=None),
    "docs/guide.md":
    TreeEntry(path="docs/guide.md", type="blob", sha="eee111", size=8500),
}

MOCK_BLOBS = {
    "aaa111":
    b"# Mock Repo\n\nA test repository.\n",
    "aaa222":
    b'[project]\nname = "mock-repo"\nversion = "0.1.0"\n',
    "bbb111":
    b"",
    "bbb222": (b"import os\nimport sys\n"
               b"from src.utils import helper\n"
               b"\nasync def main():\n    pass\n"),
    "bbb333":
    b"import json\n\ndef helper():\n    return 42\n",
    "bbb444":
    b'DB_URL = "localhost"\nDEBUG = True\n',
    "ccc111":
    b"",
    "ccc222": (b"from dataclasses import dataclass\n\n"
               b"@dataclass\nclass User:\n"
               b"    name: str\n    email: str\n"),
    "ccc333": (b"from dataclasses import dataclass\n\n"
               b"@dataclass\nclass Item:\n"
               b"    title: str\n    price: float\n"),
    "ddd111": (b"import pytest\nfrom src.main import main\n"
               b"\nasync def test_main():\n    assert True\n"),
    "ddd222": (b"import pytest\nfrom src.utils import helper\n"
               b"\ndef test_helper():\n"
               b"    assert helper() == 42\n"),
    "eee111":
    b"# User Guide\n\nThis is the user guide for the mock repo.\n",
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


@pytest.fixture
def github_config():
    return GitHubConfig(token="ghp_mock_token")


@pytest.fixture
def mock_github_api(monkeypatch):

    def _fetch_default_branch_sync(config, owner, repo):
        return MOCK_DEFAULT_BRANCH

    def _fetch_tree_sync(config, owner, repo, ref):
        return dict(MOCK_TREE), False

    async def _read_bytes(config, owner, repo, sha):
        return MOCK_BLOBS[sha]

    async def _search_code(config, owner, repo, query, path_filter=None):
        results = MOCK_SEARCH_RESULTS.get(query, [])
        if path_filter:
            results = [r for r in results if r.path.startswith(path_filter)]
        return results

    monkeypatch.setattr(
        "mirage.resource.github.github.fetch_default_branch_sync",
        _fetch_default_branch_sync)
    monkeypatch.setattr("mirage.resource.github.github.fetch_tree_sync",
                        _fetch_tree_sync)
    monkeypatch.setattr("mirage.core.github.read.read_bytes", _read_bytes)
    monkeypatch.setattr("mirage.core.github.search.search_code", _search_code)
