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


def extract_dest(explicit: PathSpec | str | None, cwd: PathSpec | str) -> str:
    """Where extraction lands, as a virtual path: the explicit operand,
    else the cwd. Outside a workspace the cwd arrives as a plain string.

    Args:
        explicit (PathSpec | str | None): tar's last -C or unzip's -d,
            when the line named one.
        cwd (PathSpec | str): the session working directory.
    """
    target = explicit if explicit is not None else cwd
    if isinstance(target, PathSpec):
        return target.virtual
    return target or "/"
