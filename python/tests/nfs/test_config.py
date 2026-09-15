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

from mirage.nfs.config import DEFAULT_PORT, NFSConfig


def test_defaults_bind_loopback_only():
    config = NFSConfig()
    assert config.host == "127.0.0.1"
    assert config.port == DEFAULT_PORT


def test_port_zero_is_allowed_for_an_os_assigned_port():
    assert NFSConfig(port=0).port == 0


@pytest.mark.parametrize("port", [-1, 65536])
def test_a_port_out_of_range_is_refused(port):
    with pytest.raises(ValueError, match="port out of range"):
        NFSConfig(port=port)


@pytest.mark.parametrize("seconds", [0.0, -1.0])
def test_a_non_positive_idle_flush_is_refused(seconds):
    with pytest.raises(ValueError, match="idle_flush_seconds"):
        NFSConfig(idle_flush_seconds=seconds)


def test_a_non_positive_buffer_ceiling_is_refused():
    with pytest.raises(ValueError, match="max_buffered_bytes"):
        NFSConfig(max_buffered_bytes=0)


def test_config_is_frozen():
    config = NFSConfig()
    with pytest.raises(Exception):
        config.port = 1234


def test_defaults_are_a_soft_bounded_mount():
    # The default has to be the survivable one: a hard mount blocks
    # every I/O forever when the server stops, and the server is the
    # process that set the mount up.
    config = NFSConfig()
    assert config.soft is True
    assert config.timeo == 50
    assert config.retrans == 3
    assert config.dead_timeout == 60


def test_a_hard_mount_is_expressible():
    assert NFSConfig(soft=False).soft is False
    assert NFSConfig(dead_timeout=0).dead_timeout == 0


def test_bad_resilience_knobs_are_refused():
    with pytest.raises(ValueError, match="timeo"):
        NFSConfig(timeo=0)
    with pytest.raises(ValueError, match="retrans"):
        NFSConfig(retrans=-1)
    with pytest.raises(ValueError, match="dead_timeout"):
        NFSConfig(dead_timeout=-1)
