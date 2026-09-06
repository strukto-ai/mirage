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

from mirage.shell.constants import (RANDOM_A, RANDOM_M, RANDOM_MAX, RANDOM_Q,
                                    RANDOM_R, RANDOM_ZERO_SEED)


def step_state(state: int) -> int:
    """One step of bash's generator (``intrand32``): Park-Miller through
    Schrage's method, a zero state stepping from the fixed seed.

    Args:
        state (int): the generator state, a 32-bit value.
    """
    ret = RANDOM_ZERO_SEED if state == 0 else state
    high = ret // RANDOM_Q
    low = ret - RANDOM_Q * high
    step = RANDOM_A * low - RANDOM_R * high
    return step + RANDOM_M if step < 0 else step


def value_of(state: int) -> int:
    """The ``$RANDOM`` value a state renders as (``brand``): the two
    16-bit halves folded, keeping 15 bits.

    Args:
        state (int): the generator state after a step.
    """
    return ((state >> 16) ^ (state & 0xFFFF)) & RANDOM_MAX


def draw(state: int, last: int) -> tuple[int, int]:
    """One ``$RANDOM`` draw: step until the value differs from the last
    one, as bash's ``get_random`` does, and return the new state with it.

    Args:
        state (int): the generator state before the draw.
        last (int): the value the previous draw rendered as, 0 after a
            seed.
    """
    while True:
        state = step_state(state)
        value = value_of(state)
        if value != last:
            return state, value
