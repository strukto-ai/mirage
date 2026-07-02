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

from mirage.commands.builtin.filetype_factory.extensions import _fmt
from mirage.io.types import IOResult


async def _ft_grep(resolve_glob,
                   read,
                   module,
                   accessor,
                   paths,
                   *texts,
                   i=False,
                   c=False,
                   index=None,
                   **kwargs):
    if not paths or not texts:
        raise ValueError("grep: missing operand")
    pattern = texts[0]
    paths = await resolve_glob(accessor, paths, index)
    p = paths[0]
    try:
        raw = await read(accessor, p, index)
        result = module.grep(raw, pattern, ignore_case=i)
        if c:
            count = len(result.decode().strip().splitlines()) - 1
            return str(max(0, count)).encode(), IOResult(
                reads={p.mount_path: raw}, cache=[p.mount_path])
        return result, IOResult(reads={p.mount_path: raw},
                                cache=[p.mount_path])
    except Exception as e:
        return None, IOResult(
            exit_code=1,
            stderr=f"grep: {p.virtual}: failed to read as {_fmt(module)}: {e}".
            encode(),
        )
