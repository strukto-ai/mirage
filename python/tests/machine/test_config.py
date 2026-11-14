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

from mirage.machine.config import MachineConfig, check_on_pause
from mirage.machine.docker import DockerConfig
from mirage.machine.e2b import E2BConfig
from mirage.machine.registry import build_machine


def test_coerce_none_gives_defaults():
    config = MachineConfig.coerce(None)
    assert config == MachineConfig()
    assert config.env == {}


def test_coerce_passes_an_instance_through():
    config = MachineConfig.coerce(MachineConfig(env={"A": "1"}))
    assert config.env == {"A": "1"}


def test_coerce_dict_form_is_a_yaml_config_block():
    config = MachineConfig.coerce({"env": {"A": "1"}})
    assert config.env == {"A": "1"}


def test_coerce_unknown_key_fails_loud():
    # A provider-only field is unknown on the base config.
    with pytest.raises(TypeError, match="container"):
        MachineConfig.coerce({"container": "cid-42"})


def test_coerce_rejects_a_sibling_provider_config():
    with pytest.raises(TypeError, match="container"):
        E2BConfig.coerce(DockerConfig(container="cid-42"))


@pytest.mark.parametrize(
    "provider, field",
    [
        ("daytona", "sandbox_id"),
        ("docker", "container"),
        ("e2b", "sandbox_id"),
        ("kubernetes", "pod"),
        ("microsandbox", "sandbox"),
        ("smolvm", "machine"),
        ("ssh", "host"),
    ],
)
@pytest.mark.parametrize("blank", ["", "  "])
def test_a_blank_required_id_is_refused(provider, field, blank):
    # A blank id would otherwise reach the provider as an empty name.
    with pytest.raises(
        ValueError, match=f"{provider} config needs a nonblank"
    ):
        build_machine("box", {"provider": provider, field: blank})


def test_an_unset_on_pause_is_left_alone():
    check_on_pause("x", None, ("pause",))


def test_on_pause_takes_one_of_the_providers_own_options():
    check_on_pause("x", "pause", ("pause",))


def test_on_pause_refuses_any_other_value_naming_the_options():
    with pytest.raises(
        ValueError, match="x on_pause must be one of pause, not 'stop'"
    ):
        check_on_pause("x", "stop", ("pause",))
