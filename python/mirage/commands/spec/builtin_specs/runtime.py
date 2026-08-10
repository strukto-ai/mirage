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

from mirage.commands.spec.types import CommandSpec, Operand, Option

# CPython's own option table, minus the interactive-only switches. The
# three groups differ in who answers them: -c/-m select the source and
# end option parsing (their argument is a program, so trailing words are
# that program's argv); the init switches are handed to the runtime
# through RunArgs.flags and honored by whichever engine can; -u is a
# structural no-op, since mirage buffers every stream and returns it
# whole. Pinned against CPython 3.12.13.
_PYTHON_OPTIONS: tuple[Option, ...] = (
    Option(short="-c",
           type="str",
           ends_options=True,
           description="Run the next argument as a program."),
    Option(short="-m",
           type="str",
           ends_options=True,
           description="Run the named module as __main__."),
    Option(short="-u",
           description=("(Ignored) Unbuffered output. Mirage buffers "
                        "every stream and returns it whole.")),
    Option(short="-B", description="Do not write .pyc files on import."),
    Option(short="-E", description="Ignore PYTHON* environment variables."),
    Option(short="-I", description="Isolated mode: implies -E and -s."),
    Option(short="-O",
           count=True,
           description=("Remove assert and __debug__ blocks; -OO also "
                        "strips docstrings.")),
    Option(short="-q",
           description=("(Ignored) Suppress the version banner. Mirage "
                        "prints none.")),
    Option(short="-s",
           description="Do not add the user site directory to sys.path."),
    Option(short="-S",
           description="Do not run 'import site' on initialization."),
    Option(short="-W",
           type="str",
           multiple=True,
           description="Set a warning control filter."),
    Option(short="-X",
           type="str",
           multiple=True,
           description="Set an implementation-specific option."),
    # Aliases of the injected help/version options, not new behavior:
    # sharing their long spelling means they share their dest, so
    # _with_help_support short-circuits them on the one path every
    # command uses. CPython's -VV adds build info; mirage has no
    # CPython build to report, so -VV clusters into -V and prints the
    # same line.
    Option(short="-h",
           long="--help",
           description="Show this help message and exit."),
    Option(short="-V",
           long="--version",
           description="Show version information and exit."),
)

SPECS: dict[str, CommandSpec] = {
    'python':
    CommandSpec(
        description="Run Python on the workspace's bound runtime.",
        options=_PYTHON_OPTIONS,
        rest=Operand(type="str"),
        stop_at_operand=True,
    ),
    'python3':
    CommandSpec(
        description="Run Python on the workspace's bound runtime.",
        options=_PYTHON_OPTIONS,
        rest=Operand(type="str"),
        stop_at_operand=True,
    ),
    'js':
    CommandSpec(
        description="Run JavaScript on a sandboxed quickjs engine.",
        options=(
            Option(short="-e",
                   type="str",
                   description="Evaluate the next argument as a script."),
            Option(short="-m",
                   long="--module",
                   description=("Run as an ES module (top-level "
                                "import/export/await); .mjs files "
                                "select this automatically.")),
        ),
        rest=Operand(type="str"),
    ),
    'node':
    CommandSpec(
        description="Run JavaScript on a sandboxed quickjs engine.",
        options=(
            Option(short="-e",
                   type="str",
                   description="Evaluate the next argument as a script."),
            Option(short="-m",
                   long="--module",
                   description=("Run as an ES module (top-level "
                                "import/export/await); .mjs files "
                                "select this automatically.")),
        ),
        rest=Operand(type="str"),
    ),
    'mktemp':
    CommandSpec(
        options=(
            Option(short="-d", long="--directory"),
            Option(short="-p", type="path"),
            Option(long="--tmpdir", type="path", value_optional=True),
            Option(short="-t"),
            Option(short="-u", long="--dry-run"),
            Option(short="-q", long="--quiet"),
            Option(long="--suffix", type="str"),
        ),
        positional=(Operand(type="str"), ),
    ),
    'bc':
    CommandSpec(
        description="Arbitrary precision calculator language.",
        options=(
            Option(short="-l", description="Load the standard math library."),
            Option(short="-q", description="Suppress the welcome banner."),
        ),
        rest=Operand(type="str"),
    ),
    'expr':
    CommandSpec(
        description="Evaluate expressions.",
        rest=Operand(type="str"),
    ),
    'history':
    CommandSpec(
        description="Show command history for the session.",
        options=(
            Option(short="-c", description="Clear the command history."),
            Option(short="-d",
                   type="str",
                   description=("Delete the entry at the given position; "
                                "negative counts back from the end.")),
            Option(short="-s",
                   description=("Append the args to the history as a "
                                "single entry without executing them.")),
            Option(short="-p",
                   description="Print the args without storing them."),
            Option(short="-a",
                   description=("Append: no-op (file and store are "
                                "the same).")),
            Option(short="-r",
                   description=("Read: no-op (file and store are "
                                "the same).")),
            Option(short="-w",
                   description=("Write: no-op (file and store are "
                                "the same).")),
            Option(short="-n",
                   description=("Read-new: no-op (file and store are "
                                "the same).")),
        ),
        rest=Operand(type="str"),
    ),
    'date':
    CommandSpec(
        description="Print or set the system date and time.",
        options=(
            Option(
                short="-d",
                type="str",
                description=("Display the time described by the given "
                             "date string."),
            ),
            Option(short="-u",
                   description="Use Coordinated Universal Time (UTC)."),
            Option(short="-I", description="Output date in ISO 8601 format."),
            Option(short="-R",
                   description="Output date in RFC 5322 email format."),
        ),
        positional=(Operand(type="str"), ),
    ),
    'sleep':
    CommandSpec(
        description="Delay for a specified amount of time.",
        rest=Operand(type="str"),
    ),
    'bash':
    CommandSpec(
        description=("Run a command string through Mirage's shell. "
                     "Only `-c` is meaningful; other flags are accepted "
                     "and ignored. `bash` and `sh` are aliases."),
        options=(
            Option(
                short="-c",
                type="str",
                description=("Read commands from the next argument "
                             "and execute them."),
            ),
            Option(
                short="-s",
                description=("Read commands from stdin instead of "
                             "from an argument."),
            ),
            Option(short="-l",
                   description=("(Ignored) Login shell. Mirage does "
                                "not source profile files.")),
            Option(short="-i",
                   description=("(Ignored) Interactive flag. Mirage "
                                "shells are non-interactive.")),
            Option(short="-e", description="(Ignored) Exit on first error."),
            Option(short="-u",
                   description="(Ignored) Treat unset variables as errors."),
            Option(short="-x",
                   description="(Ignored) Print commands as they execute."),
            Option(long="--login", description="(Ignored) Login shell."),
            Option(long="--norc", description="(Ignored) Skip rc files."),
            Option(long="--noprofile",
                   description="(Ignored) Skip profile files."),
            Option(long="--posix",
                   description="(Ignored) POSIX-conformant mode."),
        ),
        rest=Operand(type="str"),
    ),
}
