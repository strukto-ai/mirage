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

from mirage.accessor.hf_models import HfModelsAccessor, HfModelsConfig
from mirage.resource.secrets import reveal_secret


def test_config_defaults():
    cfg = HfModelsConfig(repo_id="org/model")
    assert cfg.repo_id == "org/model"
    assert cfg.namespace == "org"
    assert cfg.repo_name == "model"
    assert cfg.token is None
    assert cfg.endpoint == "https://huggingface.co"
    assert cfg.revision is None


def test_config_rejects_bad_repo_id():
    with pytest.raises(ValueError):
        HfModelsConfig(repo_id="just-one-segment")


def test_config_token_secret():
    cfg = HfModelsConfig(repo_id="org/model", token="hf_abc123")
    assert reveal_secret(cfg.token) == "hf_abc123"


def test_accessor_repo_type_and_uri():
    cfg = HfModelsConfig(repo_id="org/model")
    acc = HfModelsAccessor(cfg)
    assert acc.REPO_TYPE == "model"
    assert acc.bucket_uri == "hf://models/org/model"
