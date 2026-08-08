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

from mirage.runtime.config import RuntimeConfig
from mirage.runtime.wasm.config import WasmFsConfig
from mirage.runtime.wasm.fs import WasmVFS


def test_defaults_to_no_build_directory():
    assert WasmFsConfig().host_root is None


def test_coerces_a_dict():
    assert WasmFsConfig.coerce({"host_root": "/opt/wasi"}).host_root == \
        "/opt/wasi"


def test_unknown_field_fails_loud():
    # The whole reason this is a dataclass and not a kwargs bag: a typo
    # in a yaml config block has to raise rather than be ignored, which
    # would leave the guest quietly serving the wrong tree.
    with pytest.raises(TypeError):
        WasmFsConfig.coerce({"host_rot": "/opt/wasi"})


def test_inherits_the_runtime_config_base():
    assert issubclass(WasmFsConfig, RuntimeConfig)


def test_filesystem_accepts_the_dict_form_directly():
    fs = WasmVFS({"host_root": "/opt/wasi"})
    assert fs.config == WasmFsConfig(host_root="/opt/wasi")
