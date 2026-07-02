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

from mirage.commands.builtin.generic_bind.provision import (
    make_file_read_provision, make_head_tail_provision, make_search_provision,
    metadata_provision)
from mirage.core.postgres.stat import stat as _stat

file_read_provision = make_file_read_provision(_stat)
head_tail_provision = make_head_tail_provision(_stat)
search_provision = make_search_provision(_stat)

__all__ = [
    "file_read_provision",
    "head_tail_provision",
    "metadata_provision",
    "search_provision",
]
