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

from mirage.commands.spec.builtin_specs import (archive, fs_mutate, hashing,
                                                listing, net, runtime, search,
                                                text_proc, viewing)
from mirage.commands.spec.types import CommandSpec

_MODULES = (archive, fs_mutate, hashing, listing, net, runtime, search,
            text_proc, viewing)

SPECS: dict[str, CommandSpec] = {}
for _module in _MODULES:
    for _name in _module.SPECS:
        if _name in SPECS:
            raise ValueError(f"duplicate command spec: {_name}")
    SPECS.update(_module.SPECS)
