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

from mirage.accessor.hf_spaces import HfSpacesAccessor, HfSpacesConfig
from mirage.vfs.secrets import reveal_secret


def test_config_defaults():
    cfg = HfSpacesConfig(repo_id="org/space")
    assert cfg.repo_id == "org/space"
    assert cfg.namespace == "org"
    assert cfg.repo_name == "space"
    assert cfg.token is None
    assert cfg.endpoint == "https://huggingface.co"
    assert cfg.revision is None


def test_config_accepts_a_bare_repo_id():
    """The Hub resolves a bare name against whoever the token belongs
    to, and the real CLI relies on it: `hf repo create widget` then
    `hf download widget`. Refusing it rejected an id the Hub had just
    minted."""
    cfg = HfSpacesConfig(repo_id="widget")
    assert cfg.repo_id == "widget"
    assert cfg.namespace == ""
    assert cfg.repo_name == "widget"


@pytest.mark.parametrize("bad", ["a/b/c", "ns/", "/name", ""])
def test_config_rejects_a_shape_the_hub_cannot_read(bad):
    with pytest.raises(ValueError):
        HfSpacesConfig(repo_id=bad)


def test_config_token_secret():
    cfg = HfSpacesConfig(repo_id="org/space", token="hf_abc123")
    assert reveal_secret(cfg.token) == "hf_abc123"


def test_accessor_repo_type_and_uri():
    cfg = HfSpacesConfig(repo_id="org/space")
    acc = HfSpacesAccessor(cfg)
    assert acc.REPO_TYPE == "space"
    assert acc.bucket_uri == "hf://spaces/org/space"
