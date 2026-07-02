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


async def _ft_cut(resolve_glob,
                  read,
                  module,
                  accessor,
                  paths,
                  *texts,
                  f=None,
                  d=None,
                  c=None,
                  index=None,
                  **kwargs):
    if not paths:
        raise ValueError("cut: missing operand")
    paths = await resolve_glob(accessor, paths, index)
    p = paths[0]
    if f is None:
        return None, IOResult(
            exit_code=1,
            stderr=f"cut: -f required for {_fmt(module)} files (column names)".
            encode(),
        )
    if c is not None:
        return None, IOResult(
            exit_code=1,
            stderr=f"cut: -c not supported for {_fmt(module)}; use -f".encode(
            ),
        )
    try:
        columns = [col.strip() for col in f.split(",")]
        raw = await read(accessor, p, index)
        return module.cut(raw,
                          columns=columns), IOResult(reads={p.mount_path: raw},
                                                     cache=[p.mount_path])
    except Exception as e:
        return None, IOResult(
            exit_code=1,
            stderr=f"cut: {p.virtual}: {e}".encode(),
        )
