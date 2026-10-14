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
from mirage.runtime.sandbox.docker import DockerConfig
from mirage.runtime.sandbox.e2b import E2BConfig
from mirage.runtime.table import build_runtime


def test_coerce_none_gives_defaults():
    config = SandboxConfig.coerce(None)
    assert config == SandboxConfig()
    assert config.env == {}


def test_coerce_passes_an_instance_through():
    config = SandboxConfig.coerce(SandboxConfig(env={"A": "1"}))
    assert config.env == {"A": "1"}


def test_coerce_dict_form_is_a_yaml_config_block():
    config = SandboxConfig.coerce({"env": {"A": "1"}})
    assert config.env == {"A": "1"}


def test_coerce_unknown_key_fails_loud():
    # A provider-only field is unknown on the base config.
    with pytest.raises(TypeError, match="container"):
        SandboxConfig.coerce({"container": "cid-42"})


def test_coerce_rejects_a_sibling_provider_config():
    with pytest.raises(TypeError, match="container"):
        E2BConfig.coerce(DockerConfig(container="cid-42"))


@pytest.mark.parametrize(
    "runtime, field",
    [
        ("daytona", "sandbox_id"),
        ("docker", "container"),
        ("e2b", "sandbox_id"),
        ("microsandbox", "sandbox"),
        ("smolvm", "machine"),
        ("ssh", "host"),
    ],
)
@pytest.mark.parametrize("blank", ["", "  "])
def test_a_blank_required_id_is_refused(runtime, field, blank):
    # A blank id would otherwise reach the provider as an empty name.
    with pytest.raises(ValueError, match=f"{runtime} config needs a nonblank"):
        build_runtime(runtime, config={field: blank})
