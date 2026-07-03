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

from mirage.commands.builtin.generic_bind.adapter import (CommandIO,
                                                          make_resolve_glob)
from mirage.commands.builtin.generic_bind.factory import (
    make_generic_commands, with_read_cache, with_stat_cache)
from mirage.commands.builtin.generic_bind.provision import (
    default_provision, make_copy_provision, make_file_read_provision,
    make_head_tail_provision, make_jq_provision, make_search_provision,
    make_sed_provision, make_transform_provision, metadata_provision,
    pure_provision, write_metadata_provision)

__all__ = [
    "CommandIO",
    "default_provision",
    "make_copy_provision",
    "make_file_read_provision",
    "make_generic_commands",
    "make_head_tail_provision",
    "make_jq_provision",
    "make_resolve_glob",
    "make_search_provision",
    "make_sed_provision",
    "make_transform_provision",
    "metadata_provision",
    "pure_provision",
    "with_read_cache",
    "with_stat_cache",
    "write_metadata_provision",
]
