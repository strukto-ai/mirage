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

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field, replace


@dataclass
class CallFrame:
    positional: list[str] = field(default_factory=list)
    locals: dict[str, str] = field(default_factory=dict)
    function_name: str = ""
    loop_level: int = 0
    sourced: bool = False
    closed: bool = False


class CallStack:
    def __init__(self) -> None:
        self._frames: list[CallFrame] = [CallFrame()]
        # A fork is a child shell's stack: an error that discards the
        # rest of the line ends the child instead of resuming.
        self.subshell = False
        # A `( )` subshell, a compound command forked as a stage or job,
        # or a fork of one: a refused `${var:=word}` ends it with 2.
        self.paren = False

    def fork(
        self, loops: bool = True, paren: bool | None = None
    ) -> "CallStack":
        """The stack a child shell runs on, a copy of every frame.

        Args:
            loops (bool): keep the loops the caller is in, as a pipeline
                stage and ``$( )`` do; a ``( )`` or ``&`` child starts
                outside every loop (bash 5.2, POSIX interp 842).
            paren (bool | None): the child runs a ``( )`` or a compound
                command (True) or a substitution (False); None keeps the
                caller's.
        """
        child = CallStack()
        child._frames = [
            replace(
                frame,
                positional=list(frame.positional),
                locals=dict(frame.locals),
                loop_level=frame.loop_level if loops else 0,
            )
            for frame in self._frames
        ]
        child.subshell = True
        child.paren = self.paren if paren is None else paren
        return child

    @property
    def current(self) -> CallFrame:
        return self._frames[-1]

    def push(
        self,
        positional: list[str] | None = None,
        function_name: str = "",
        sourced: bool = False,
    ) -> None:
        """Enter a function, or a sourced file (``function_name`` is
        ``source``). A function starts outside every loop, so ``break``
        in it cannot end its caller's; a sourced file runs in its
        caller's loops.

        Args:
            positional (list[str] | None): the frame's ``$1``... .
            function_name (str): what ``FUNCNAME`` names the frame.
            sourced (bool): the frame is a sourced file's.
        """
        self._frames.append(
            CallFrame(
                positional=positional or [],
                function_name=function_name,
                loop_level=self.current.loop_level if sourced else 0,
                sourced=sourced,
            )
        )

    def pop(self) -> CallFrame:
        if len(self._frames) <= 1:
            return self._frames[0]
        return self._frames.pop()

    @property
    def depth(self) -> int:
        return len(self._frames)

    @property
    def returnable(self) -> bool:
        """Whether a function or sourced file is running for ``return``
        to leave."""
        return any(not frame.closed for frame in self._frames[1:])

    @contextmanager
    def loop(self) -> Iterator[None]:
        """Count a loop the current frame runs, for ``break`` and
        ``continue`` to find."""
        frame = self.current
        frame.loop_level += 1
        try:
            yield
        finally:
            frame.loop_level -= 1

    def function_names(self) -> tuple[str, ...]:
        """``${FUNCNAME[@]}``: the frames innermost first, a sourced
        file as ``source``. Empty while no function runs, as bash hides
        a sourced file's entry outside one, and one whose RETURN action
        runs: it has returned."""
        frames = [frame for frame in self._frames[1:] if not frame.closed]
        if all(frame.sourced for frame in frames):
            return ()
        return tuple(frame.function_name for frame in reversed(frames))

    def get_positional(self, index: int) -> str:
        pos = self.current.positional
        if 0 < index <= len(pos):
            return pos[index - 1]
        return ""

    def get_all_positional(self) -> list[str]:
        return self.current.positional

    def get_positional_count(self) -> int:
        return len(self.current.positional)

    def shift(self, n: int = 1) -> None:
        self.current.positional = self.current.positional[n:]

    def set_positional(self, values: list[str]) -> None:
        self.current.positional = values

    def set_local(self, name: str, value: str) -> None:
        self.current.locals[name] = value

    def get_local(self, name: str) -> str | None:
        for frame in reversed(self._frames):
            if name in frame.locals:
                return frame.locals[name]
        return None
