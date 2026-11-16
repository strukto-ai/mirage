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

from mirage.resources.refs import secret_refs


def test_a_keyed_pointer_and_a_managed_env_entry_name_a_saved_entry():
    config = {
        "mounts": {
            "/gh": {
                "vfs": "github",
                "config": {
                    "token": {"from": "strukto", "ref": "gh", "key": "token"}
                },
            }
        },
        "machines": {
            "box": {"provider": "host", "env": {"from": "strukto", "ref": "x"}}
        },
        "env": {
            "TOKEN": {"from": "strukto", "ref": "ci", "readonly": True},
            "PLAIN": {"value": "v", "readonly": True},
        },
    }
    assert secret_refs(config) == ["gh", "ci"]
