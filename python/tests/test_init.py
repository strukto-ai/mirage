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

import mirage


def test_all_names_resolve():
    missing = [name for name in mirage.__all__ if not hasattr(mirage, name)]
    assert missing == []


def test_authoring_surface_is_stable():
    # The root is the public contract for an out-of-tree resource, CLI,
    # policy, runtime or secrets source, the way @struktoai/mirage-core's
    # index.ts is; removing a name is a breaking change and must be
    # deliberate.
    assert set(mirage.__all__) >= {
        "Accessor",
        "BaseResource",
        "CLISpec",
        "CommandIO",
        "CommandSpec",
        "FileStat",
        "FlagView",
        "GenericResource",
        "IOResult",
        "Mount",
        "PathSpec",
        "Policy",
        "Runtime",
        "SPECS",
        "Workspace",
        "build_resource",
        "command",
        "known_resources",
        "known_runtimes",
        "known_sources",
        "make_generic_commands",
        "make_generic_ops",
        "make_resolve_glob",
        "op",
        "register_cli_spec",
        "register_resource",
        "register_runtime",
        "register_secrets",
        "stream_from_bytes",
    }
