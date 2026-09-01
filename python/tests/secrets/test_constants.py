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

from pydantic import BaseModel

from mirage.secrets.constants import BUILTINS


def test_builtin_names_are_the_v1_sources():
    assert sorted(BUILTINS) == ["1password", "aws-sm", "dotenv", "env"]


def test_builtin_entries_pair_a_config_model_with_an_import_path():
    for name, (config_model, fetch_path) in BUILTINS.items():
        assert issubclass(config_model, BaseModel), name
        module_name, sep, attr = fetch_path.partition(":")
        assert sep == ":", name
        assert module_name.startswith("mirage.secrets."), name
        assert attr.startswith("fetch_"), name
