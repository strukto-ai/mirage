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

from mirage.runtime.config import HomeConfig, RuntimeConfig, memory_limit
from mirage.runtime.sandbox.config import SandboxConfig


def test_coerce_none_gives_defaults():
    assert HomeConfig.coerce(None) == HomeConfig()
    assert HomeConfig.coerce(None).home is None


def test_coerce_dict_builds_typed_config():
    cfg = HomeConfig.coerce({"home": "/opt/build"})
    assert cfg == HomeConfig(home="/opt/build")


def test_coerce_instance_passes_through():
    cfg = HomeConfig(home="/opt/build")
    assert HomeConfig.coerce(cfg) is cfg


def test_coerce_base_instance_converts():
    assert HomeConfig.coerce(RuntimeConfig()) == HomeConfig()


def test_coerce_unknown_key_fails_loud():
    with pytest.raises(TypeError):
        HomeConfig.coerce({"hoem": "/typo"})


def test_base_config_has_no_fields():
    with pytest.raises(TypeError):
        RuntimeConfig.coerce({"home": "/anything"})


@pytest.mark.parametrize("env", [["A=1"], {"A": 1}, {1: "a"}])
def test_coerce_refuses_an_env_that_is_not_strings(env):
    with pytest.raises(ValueError, match="map strings to strings"):
        SandboxConfig.coerce({"env": env})


@pytest.mark.parametrize(
    ("value", "size"),
    [
        (None, None),
        ("10M", 10 << 20),
        (" 1g ", 1 << 30),
        ("512KB", 512 << 10),
        ("4096", 4096),
        (1048576, 1048576),
    ],
)
def test_memory_limit_reads_a_size_or_a_count_of_bytes(value, size):
    assert memory_limit(value) == size


@pytest.mark.parametrize("value", ["lots", "1.5G", "-5M", "+5M", -1, True])
def test_memory_limit_refuses_anything_else(value):
    with pytest.raises(ValueError, match="max_memory must be a size"):
        memory_limit(value)
