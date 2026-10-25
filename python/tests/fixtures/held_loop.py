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
import asyncio
from collections.abc import Callable, Coroutine
from typing import Any, TypeVar

T = TypeVar("T")


class HeldLoop(asyncio.SelectorEventLoop):
    """A loop whose clock moves only when a test moves ``now``.

    It stands for a loop that keeps virtual time: real time passing
    never reaches ``time()``, and a timer fires only once ``now``
    reaches it.
    """

    def __init__(self) -> None:
        super().__init__()
        self.now = 100.0

    def time(self) -> float:
        return self.now


def run_on_held_loop(
    main: Callable[[HeldLoop], Coroutine[Any, Any, T]],
) -> T:
    """Run ``main`` to completion on a fresh `HeldLoop`.

    Args:
        main (Callable[[HeldLoop], Coroutine[Any, Any, T]]): takes the
            loop it runs on.
    """
    with asyncio.Runner(loop_factory=HeldLoop) as runner:
        loop = runner.get_loop()
        assert isinstance(loop, HeldLoop)
        return runner.run(main(loop))
