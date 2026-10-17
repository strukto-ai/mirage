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

from typing import ClassVar

from mirage.commands.config import Context
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.mixin import E
from mirage.runtime.python.execution import PAYLOAD_ARGV0, STDIN_ARGV0
from mirage.runtime.source import Argv0Rules
from mirage.runtime.types import Language, Program, RunResult

# CPython's own four answers, pinned on 3.12.13/3.13.7.
CPYTHON_ARGV0 = Argv0Rules(
    payload=PAYLOAD_ARGV0,
    stdin_operand=STDIN_ARGV0,
    bare_stdin="",
    names_file=True,
)


# `-m` is runpy's job on any real CPython: run_module finds the module,
# runs it under __main__, and alter_sys rewrites sys.argv[0] to the
# module's own file, which is what CPython puts there. Engines that are
# not CPython declare runs_modules False and never see this.
#
# The existence probe is not redundant with run_module: CPython answers
# a missing module with one line and exit 1, while bare run_module
# raises, which would reach the user as a runpy traceback. Probing
# first also keeps an ImportError raised INSIDE the module distinct
# from the module itself being absent, which a try around run_module
# could not tell apart.
def module_source(name: str, label: str) -> str:
    """The script ``python -m`` runs for one module.

    Args:
        name (str): the module to run.
        label (str): the command name the not-found message uses.
    """
    return (
        "import importlib.util, runpy, sys\n"
        f"_name = {name!r}\n"
        f"_label = {label!r}\n"
        "try:\n"
        "    _found = importlib.util.find_spec(_name) is not None\n"
        "except (ImportError, TypeError, ValueError):\n"
        # find_spec raises rather than returning None when an ancestor of a
        # dotted name is missing or is not a package; either way the module
        # cannot be found, and the message below reports it.
        "    _found = False\n"
        "if not _found:\n"
        "    sys.stderr.write(_label + ': No module named ' + _name + chr(10))\n"
        "    raise SystemExit(1)\n"
        "runpy.run_module(_name, run_name='__main__', alter_sys=True)\n"
    )


class PythonRuntime(LanguageRuntime[E]):
    """The python tier: every runtime that interprets Python source.

    Groups the engines behind the python3/python commands (monty,
    wasi, local here; pyodide in TypeScript), so ``language`` and the
    default ``captures`` are declared once and python-tier behavior
    has one home. A new Python engine subclasses this, not
    LanguageRuntime.
    """

    language: ClassVar[Language] = "python"
    # The tier's head words: the class-default captures of every
    # python engine.
    commands: ClassVar[tuple[str, ...]] = ("python3", "python")
    captures = commands
    argv0_rules: ClassVar[Argv0Rules] = CPYTHON_ARGV0
    # Whether `python3 -m mod` can run at all. True for every engine
    # that is real CPython, since runpy does the work; False for an
    # engine implementing a subset of the language with no import
    # system to find a module with. A capability of the tier, declared
    # here rather than probed, so a refusal can name the runtime.
    runs_modules: ClassVar[bool] = True
    version_suffix: ClassVar[str] = ""

    def module_code(self, name: str, label: str) -> str | None:
        return module_source(name, label) if self.runs_modules else None

    async def version(self, env: dict[str, str]) -> RunResult:
        # Process runtimes must supply a probe that cannot run startup hooks.
        if self.reach != "workspace":
            return await super().version(env)
        return await self.interpret(
            await self.engine(),
            Program(
                code=(
                    "import sys\n"
                    "print('Python ' + sys.version.split()[0] + "
                    f"{self.version_suffix!r})"
                )
            ),
            Context(env=env),
        )
