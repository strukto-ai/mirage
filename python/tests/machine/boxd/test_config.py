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

from mirage.machine.boxd import BoxdConfig


def test_coerce_dict_covers_all_fields():
    config = BoxdConfig.coerce(
        {
            "machine_id": "m-live",
            "api_key": "k-123",
            "region": "nyc",
            "env": {"A": "1"},
        }
    )
    assert config.machine_id == "m-live"
    assert config.api_key == "k-123"
    assert config.region == "nyc"
    assert config.env == {"A": "1"}


def test_machine_id_is_required():
    with pytest.raises(TypeError, match="machine_id"):
        BoxdConfig.coerce({"api_key": "k-123"})


def test_a_blank_machine_id_fails_loud():
    with pytest.raises(ValueError, match="nonblank machine_id"):
        BoxdConfig.coerce({"machine_id": " "})


def test_an_unknown_field_fails_loud():
    with pytest.raises(TypeError, match="sandbox_id"):
        BoxdConfig.coerce({"machine_id": "m-live", "sandbox_id": "x"})
