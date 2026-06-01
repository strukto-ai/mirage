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

from mirage.types import PathSpec


def _to_scope(path: str) -> PathSpec:
    """Wrap a resolved path string as PathSpec."""
    last_slash = path.rfind("/")
    directory = path[:last_slash + 1] if last_slash >= 0 else "/"
    return PathSpec(original=path, directory=directory, resolved=True)


def _scope_path(val) -> str:
    """Extract path string from str or PathSpec."""
    if isinstance(val, PathSpec):
        return val.original
    return val
