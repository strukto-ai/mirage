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

from mirage.core.github.config import GhConfig
from mirage.core.github.placeholder import expand

CONFIG = GhConfig(token="t", repo="acme/tools", branch="main")


def test_expands_the_three_gh_documents():
    assert expand("repos/{owner}/{repo}/branches/{branch}",
                  CONFIG) == "repos/acme/tools/branches/main"


def test_leaves_a_path_with_no_braces_untouched():
    assert expand("/user", CONFIG) == "/user"


# gh leaves an unknown placeholder alone and lets the request go out; the
# API answers 404 for the literal segment. Probed against gh 2.85, which
# returns GitHub's own Not Found rather than a client-side error.
def test_leaves_an_unknown_placeholder_on_the_wire():
    assert expand("repos/{owner}/{nope}", CONFIG) == "repos/acme/{nope}"


def test_reads_the_owner_off_a_host_qualified_repo():
    config = GhConfig(token="t", repo="github.com/acme/tools")
    assert expand("repos/{owner}/{repo}", config) == "repos/acme/tools"


def test_refuses_owner_when_the_install_names_no_repository():
    with pytest.raises(ValueError, match="unable to expand placeholder"):
        expand("repos/{owner}/x", GhConfig(token="t"))


# `branch` is its own field: an install may name a repository without
# pinning a branch, and gh reports the failure rather than guessing one.
def test_refuses_branch_when_the_install_pins_none():
    config = GhConfig(token="t", repo="acme/tools")
    with pytest.raises(ValueError, match="no `branch` on the install"):
        expand("repos/{owner}/{repo}/branches/{branch}", config)
