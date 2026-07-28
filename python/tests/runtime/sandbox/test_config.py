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

from mirage.runtime.sandbox.config import SandboxConfig


def test_coerce_none_gives_defaults():
    config = SandboxConfig.coerce(None)
    assert config == SandboxConfig()
    assert config.env == {}
    assert config.args == []
    assert config.params == {}


def test_coerce_passes_an_instance_through():
    config = SandboxConfig(image="python:3.13")
    assert SandboxConfig.coerce(config) is config


def test_coerce_dict_form_is_a_yaml_config_block():
    config = SandboxConfig.coerce({
        "template": "mirage-fuse",
        "env": {
            "A": "1"
        },
        "params": {
            "auto_stop_interval": 10
        },
    })
    assert config.template == "mirage-fuse"
    assert config.env == {"A": "1"}
    assert config.params == {"auto_stop_interval": 10}


def test_coerce_unknown_key_fails_loud():
    with pytest.raises(TypeError, match="snapshot"):
        SandboxConfig.coerce({"snapshot": "mirage-fuse"})


def test_sized_reflects_any_sizing_field():
    assert SandboxConfig().sized() is False
    assert SandboxConfig(image="x").sized() is False
    assert SandboxConfig(cpu=1).sized() is True
    assert SandboxConfig(gpu="H100").sized() is True
