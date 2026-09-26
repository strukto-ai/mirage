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

from mirage.commands.builtin.generic.crossmount.types import Cmd


def combined_exit(cmd_name: str,
                  codes: list[int],
                  errored: list[bool] | None = None,
                  quiet: bool = False) -> int:
    # grep-style: ``-q`` with a match exits 0 whatever else failed (GNU
    # grep and ripgrep both), then a usage error (2) dominates, then a
    # failed operand (a read error, seen as exit 1 with stderr) forces 1
    # even when another operand matched, then any match wins (0), then
    # no-match (1). Everything else: worst operand wins.
    #
    # A read error is no longer one of the codes this has to invent: the
    # generics answer GNU's own number for a failed read, so a failed
    # operand arrives here as 2 and the exit-2 branch carries it through.
    # The `errored` branch below is for an operand that reported something
    # on stderr while still exiting 1, which no read failure does now.
    if cmd_name in (Cmd.GREP, Cmd.RG):
        if quiet and 0 in codes:
            return 0
        if any(code > 1 for code in codes):
            return max(codes)
        if errored is not None and any(errored):
            return 1
        if 0 in codes:
            return 0
        return max(codes, default=0)
    return max(codes, default=0)
