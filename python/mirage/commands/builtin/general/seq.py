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

from mirage.accessor.base import Accessor, NOOPAccessor
from mirage.commands.builtin.generic_bind.provision import pure_provision
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import CommandName
from mirage.commands.spec.usage import extra_operand_error
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _seq_generate(texts: tuple[str, ...], separator: str, width: bool,
                  fmt: str | None) -> str:
    nums = [float(t) for t in texts]
    if len(nums) == 1:
        first, step, last = 1, 1, int(nums[0])
    elif len(nums) == 2:
        first, step, last = int(nums[0]), 1, int(nums[1])
    else:
        first, step, last = int(nums[0]), int(nums[1]), int(nums[2])
    values: list[int] = []
    cur = first
    if step > 0:
        while cur <= last:
            values.append(cur)
            cur += step
    elif step < 0:
        while cur >= last:
            values.append(cur)
            cur += step
    if fmt is not None:
        parts = [fmt % v for v in values]
    elif width:
        w = max((len(str(v)) for v in values), default=1)
        parts = [str(v).zfill(w) for v in values]
    else:
        parts = [str(v) for v in values]
    return separator.join(parts) + "\n"


@command("seq", resource=None, spec=SPECS["seq"], provision=pure_provision)
async def seq(
    accessor: Accessor = NOOPAccessor(),
    paths: list[PathSpec] | None = None,
    *texts: str,
    stdin: bytes | None = None,
    s: str | None = None,
    w: bool = False,
    f: str | None = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if len(texts) > 3:
        raise extra_operand_error(CommandName.SEQ, texts[3])
    separator = s if s is not None else "\n"
    result = _seq_generate(texts, separator, w, f)
    return result.encode(), IOResult()
