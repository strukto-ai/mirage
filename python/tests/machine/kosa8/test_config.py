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

from mirage.machine.kosa8.config import Kosa8Config, egress_policy


def test_nothing_set_starts_a_sandbox_from_kosa8s_defaults():
    config = Kosa8Config()
    assert config.sandbox_id is None
    assert egress_policy(config) is None


def test_a_blank_sandbox_id_is_refused():
    with pytest.raises(ValueError, match="nonblank sandbox_id"):
        Kosa8Config(sandbox_id=" ")


@pytest.mark.parametrize(
    "field,value",
    [
        ("template", "base"),
        ("image", "python:3.12-slim"),
        ("idle_timeout", 30),
        ("secrets", ["OPENAI"]),
    ],
)
def test_start_settings_are_refused_beside_a_sandbox_id(field, value):
    with pytest.raises(ValueError, match=f"kosa8: {field} applies"):
        Kosa8Config(sandbox_id="sbx_1", **{field: value})


def test_a_template_and_an_image_together_are_refused():
    with pytest.raises(ValueError, match="template or an image"):
        Kosa8Config(template="base", image="debian:12")


@pytest.mark.parametrize("idle", [0, 0.5, -1, True, float("inf"), "60"])
def test_idle_timeout_must_be_at_least_a_second(idle):
    with pytest.raises(ValueError, match="idle_timeout"):
        Kosa8Config(idle_timeout=idle)


def test_on_pause_takes_only_pause():
    assert (
        Kosa8Config(sandbox_id="sbx_1", on_pause="pause").on_pause == "pause"
    )
    with pytest.raises(ValueError, match="on_pause"):
        Kosa8Config(sandbox_id="sbx_1", on_pause="stop")


def test_lists_become_tuples():
    config = Kosa8Config(allowed_domains=["pypi.org"], secrets=["GH"])
    assert config.allowed_domains == ("pypi.org",)
    assert config.secrets == ("GH",)


@pytest.mark.parametrize("value", ["pypi.org", ["", "x.org"], [1]])
def test_a_list_must_hold_names(value):
    with pytest.raises(ValueError, match="list of names"):
        Kosa8Config(allowed_domains=value)


@pytest.mark.parametrize(
    "entry", ["api.github.com:443", "*:22", "[::1]:8080", "::1"]
)
def test_ports_and_ipv6_are_refused(entry):
    with pytest.raises(ValueError, match="not ports or IPv6"):
        Kosa8Config(denied_domains=[entry])


def test_network_must_be_a_boolean():
    with pytest.raises(ValueError, match="true or false"):
        Kosa8Config(network="no")


@pytest.mark.parametrize("network", [True, False])
def test_network_and_an_allow_list_contradict(network):
    with pytest.raises(ValueError, match="network:"):
        Kosa8Config(network=network, allowed_domains=["pypi.org"])


@pytest.mark.parametrize(
    "config,policy",
    [
        ({"network": False}, {"internet": False}),
        ({"network": True}, {"internet": True}),
        (
            {"allowed_domains": ["pypi.org", "*.github.com", "10.0.0.0/8"]},
            {
                "internet": False,
                "allow": ["pypi.org", "*.github.com", "10.0.0.0/8"],
            },
        ),
        ({"allowed_domains": []}, {"internet": False, "allow": []}),
        ({"allowed_domains": ["*"]}, {"internet": True}),
        (
            {"denied_domains": ["gist.github.com"]},
            {"internet": True, "deny": ["gist.github.com"]},
        ),
        (
            {
                "allowed_domains": ["*.github.com"],
                "denied_domains": ["gist.github.com"],
            },
            {
                "internet": False,
                "allow": ["*.github.com"],
                "deny": ["gist.github.com"],
            },
        ),
        ({"denied_domains": ["*"]}, {"internet": False}),
    ],
)
def test_network_settings_compile_to_a_kosa8_egress_policy(config, policy):
    assert egress_policy(Kosa8Config(**config)) == policy
