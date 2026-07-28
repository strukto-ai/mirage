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

from mirage.runtime.sandbox.daytona import DaytonaConfig


def test_sized_reflects_any_sizing_field():
    assert DaytonaConfig().sized() is False
    assert DaytonaConfig(image="cuda:12").sized() is False
    assert DaytonaConfig(cpu=1).sized() is True
    assert DaytonaConfig(gpu="H100").sized() is True


def test_coerce_dict_covers_all_fields():
    config = DaytonaConfig.coerce({
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
