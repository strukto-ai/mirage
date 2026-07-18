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

import mirage.sdk as sdk


def test_all_names_resolve():
    missing = [name for name in sdk.__all__ if not hasattr(sdk, name)]
    assert missing == []


def test_blessed_surface_is_stable():
    # The SDK is the public contract for out-of-tree backends; removing
    # a name is a breaking change and must be deliberate.
    assert set(sdk.__all__) >= {
        "Accessor",
        "BaseResource",
        "CommandIO",
        "CommandSpec",
        "FileStat",
        "FlagView",
        "GenericResource",
        "IOResult",
        "PathSpec",
        "SPECS",
        "build_resource",
        "command",
        "known_resources",
        "make_generic_commands",
        "make_resolve_glob",
        "op",
        "register_resource",
    }
