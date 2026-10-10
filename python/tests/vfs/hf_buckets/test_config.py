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

from mirage.vfs.hf_buckets.config import HfBucketsConfig, HfRepoConfig


@pytest.mark.parametrize("repo_id", ["org/repo", "widget"])
def test_a_repo_id_takes_either_spelling_the_hub_accepts(repo_id):
    """The Hub resolves a bare name against whoever the token belongs
    to, and the real CLI relies on it: `hf repo create widget` then
    `hf download widget`. Refusing it rejected an id the Hub had just
    minted."""
    assert HfRepoConfig(repo_id=repo_id).repo_id == repo_id


@pytest.mark.parametrize(
    "field,bad",
    [
        ("bucket", "just-one-segment"),
        ("bucket", "too/many/slashes"),
        ("bucket", "/leading"),
        ("repo_id", "a/b/c"),
        ("repo_id", "ns/"),
        ("repo_id", "/name"),
        ("repo_id", ""),
    ],
)
def test_a_shape_the_hub_cannot_read_is_refused(field, bad):
    config_cls = HfBucketsConfig if field == "bucket" else HfRepoConfig
    with pytest.raises(ValueError):
        config_cls(**{field: bad})
