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

# Runtimes a deployment ships as a file and names from yaml
# (`runtimes: [{name: ./box_runtimes.py:EchoBox}]`), one per tier the
# workspace can route to. EchoBox takes whole lines (the line-executor
# door every sandbox provider uses) and answers with the raw line, so a
# case can see exactly what reached it. ShoutPython is an interpreter
# (the door python3 and node use): the workspace splits the line, hands
# the captured stage's code to run(), and gets it back upper-cased. The
# TypeScript twins beside this file must behave identically, because the
# point of the ref form is that one deployment runs on both hosts.

from mirage import (LanguageRuntime, LineExecutorMixin, RunArgs, RunResult,
                    Runtime)


class EchoBox(Runtime, LineExecutorMixin):
    name = "echobox"
    captures = ("nvidia-smi", )

    async def run_line(self, line: str, stdin: bytes | None,
                       env: dict[str, str], cwd: str) -> RunResult:
        return RunResult(stdout=f"box:{line}\n".encode(),
                         stderr=None,
                         exit_code=0)


class ShoutPython(LanguageRuntime):
    name = "shout"
    language = "python"
    captures = ("python3", "python")

    async def run(self, args: RunArgs) -> RunResult:
        return RunResult(stdout=f"{args.code.upper()}\n".encode(),
                         stderr=None,
                         exit_code=0)


# Loadable, but not a runtime: the reference form must refuse it by name.
NOT_A_RUNTIME = {"name": "nope"}
