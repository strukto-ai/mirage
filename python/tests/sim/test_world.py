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

from tests.sim.world import Sim, simulate

AWKWARD = b"don't $HOME `x`\n\xff\n"


async def _read_write_read(sim: Sim) -> tuple[bytes, int, bytes]:
    a = await sim.workspace().actor("a", "sa")
    seen = (await a.read("my key")).stdout
    wrote = (await a.write("my key")).exit_code
    return seen, wrote, (await a.read("my key")).stdout


def test_modeled_lines_round_trip_any_content_and_key():
    (seen, wrote, after), _ = simulate(
        _read_write_read, files={"my key": AWKWARD}
    )
    assert (seen, wrote) == (AWKWARD, 0)
    assert after.startswith(AWKWARD) and after.endswith(b"\n")
    assert after.count(b"\n") == AWKWARD.count(b"\n") + 1
