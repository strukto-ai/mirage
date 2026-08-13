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
from pydantic import ValidationError

from mirage.resource.hf_models import HfModelsConfig, HfModelsResource
from mirage.types import ResourceName


def test_resource_name():
    r = HfModelsResource(HfModelsConfig(repo_id="org/model"))
    assert r.name == ResourceName.HF_MODELS
    assert r.caches_reads is True


def test_config_immutable():
    cfg = HfModelsConfig(repo_id="org/model")
    with pytest.raises(ValidationError):
        cfg.repo_id = "other/other"


def test_resource_registers_ops_and_commands():
    r = HfModelsResource(HfModelsConfig(repo_id="org/model"))
    op_names = {o.name for o in r.ops_list()}
    cmd_names = {c.name for c in r.commands()}
    assert {"read", "readdir", "stat"} <= op_names
    assert {"cat", "ls", "stat"} <= cmd_names
