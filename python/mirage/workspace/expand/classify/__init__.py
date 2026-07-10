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

from mirage.workspace.expand.classify.heuristic import classify_word
from mirage.workspace.expand.classify.parts import classify_parts
from mirage.workspace.expand.classify.path import classify_bare_path
from mirage.workspace.expand.classify.relative import relative_spec

__all__ = [
    "classify_bare_path",
    "classify_parts",
    "classify_word",
    "relative_spec",
]
