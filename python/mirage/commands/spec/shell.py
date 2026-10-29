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

from dataclasses import dataclass, field

from mirage.commands.spec.builtin_specs import SPECS
from mirage.commands.spec.compile import (
    compile_spec,
    expand_long,
    option_spellings,
)
from mirage.commands.spec.constants import HELP_OPTION, VERSION_OPTION
from mirage.commands.spec.types import Argument, CommandSpec

_DECLARE_OPTIONS = (
    Argument(
        "-a",
        action="store_true",
        help="make each NAME an indexed array",
    ),
    Argument(
        "-A",
        action="store_true",
        help="make each NAME an associative array",
    ),
    Argument(
        "-f",
        action="store_true",
        help="act on functions only; with -p, print their definitions",
    ),
    Argument("-F", action="store_true", help="print function names only"),
    Argument(
        "-g",
        action="store_true",
        help="make NAME global even inside a function",
    ),
    Argument(
        "-i",
        action="store_true",
        help="make each NAME an integer, assigned arithmetically",
    ),
    Argument(
        "-I",
        action="store_true",
        help="inside a function, start from an outer variable's attributes",
    ),
    Argument(
        "-l",
        action="store_true",
        help="lowercase each value as it is assigned",
    ),
    Argument(
        "-n",
        action="store_true",
        help="make NAME a reference to the variable its value names",
    ),
    Argument(
        "-p",
        action="store_true",
        help="print each NAME with its attributes and value",
    ),
    Argument("-r", action="store_true", help="make each NAME read-only"),
    Argument(
        "-t",
        action="store_true",
        help="give each NAME the trace attribute",
    ),
    Argument(
        "-u",
        action="store_true",
        help="uppercase each value as it is assigned",
    ),
    Argument("-x", action="store_true", help="export each NAME"),
)

_DECLARE_TEXT = (
    "Gives each NAME the attributes its options name and assigns VALUE when "
    "one is given. With no NAME, prints the variables that have those "
    "attributes. Writing `+' in place of `-' removes an attribute. Inside a "
    "function, each NAME is local to it, as with `local', unless -g is "
    "given."
)

_DECLARE_STATUS = "0 unless an option or an assignment is invalid."

_MAPFILE_OPTIONS = (
    Argument(
        "-d",
        metavar="delim",
        help="end each line at DELIM rather than at a newline",
    ),
    Argument(
        "-n",
        metavar="count",
        help="read at most COUNT lines; 0 reads them all",
    ),
    Argument(
        "-O",
        metavar="origin",
        help="store the first line at index ORIGIN rather than 0",
    ),
    Argument("-s", metavar="count", help="skip the first COUNT lines"),
    Argument(
        "-t",
        action="store_true",
        help="drop the delimiter from the end of each line",
    ),
    Argument(
        "-u",
        metavar="fd",
        help="read from file descriptor FD rather than standard input",
    ),
    Argument(
        "-C",
        metavar="callback",
        help="run CALLBACK every QUANTUM lines",
    ),
    Argument(
        "-c",
        metavar="quantum",
        help="how many lines go between CALLBACK runs; 5000 by default",
    ),
    Argument("texts", nargs="*", metavar=""),
)

_MAPFILE_TEXT = (
    "Reads lines from standard input into the indexed array ARRAY, or "
    "MAPFILE when no ARRAY is named, one line per element."
)

_MAPFILE_STATUS = (
    "0 unless an option is invalid or ARRAY is read-only or not an indexed "
    "array."
)

_SOURCE = CommandSpec(
    description=(
        "Run the commands of a file in the current shell.\n\n"
        "Reads FILENAME and runs its commands in this shell, so the "
        "variables, functions and working directory they set stay set. "
        "ARGUMENTS, when given, are the positional parameters while it "
        "runs."
    ),
    epilog=(
        "The status of the last command FILENAME ran, or failure when it "
        "cannot be read."
    ),
)

# The grammar of each command the shell runs itself, and what `help`,
# `NAME --help` and `man` say of it: the first paragraph of the
# description is its summary, the epilog its exit status. The wrapper
# builtins and `read` and `mapfile` scan their options from it too.
SHELL_SPECS: dict[str, CommandSpec] = {
    "xargs": CommandSpec(
        description="Build and run command lines from standard input.",
        arguments=(
            Argument(
                "-0",
                "--null",
                action="store_true",
                help="Input items are terminated by NUL.",
            ),
            Argument(
                "-a",
                "--arg-file",
                type="str",
                help="Read items from this file, not standard input.",
            ),
            Argument(
                "-d",
                "--delimiter",
                type="str",
                help="Input items are separated by this character.",
            ),
            Argument(
                "-E",
                type="str",
                help="Stop reading at this logical end-of-file string.",
            ),
            Argument(
                "-e",
                "--eof",
                type="str",
                nargs="?",
                attached_only=True,
                help="Same as -E; no string turns it off.",
            ),
            Argument(
                "-I",
                type="str",
                help="Replace this string in the initial "
                "arguments with each input line.",
            ),
            Argument(
                "-i",
                "--replace",
                type="str",
                nargs="?",
                attached_only=True,
                help="Same as -I, with {} when no string is attached.",
            ),
            Argument(
                "-L",
                type="str",
                help="Use at most N non-blank input lines per command line.",
            ),
            Argument(
                "-l",
                "--max-lines",
                type="str",
                nargs="?",
                attached_only=True,
                help="Same as -L, with 1 when no count is attached.",
            ),
            Argument(
                "-n",
                "--max-args",
                type="str",
                help="Use at most N arguments per command line.",
            ),
            Argument(
                "-o",
                "--open-tty",
                action="store_true",
                help="Reopen stdin as the terminal in each "
                "command (there is no terminal, so this fails).",
            ),
            Argument(
                "-p",
                "--interactive",
                action="store_true",
                help="Prompt before running each command "
                "(there is no terminal, so this fails).",
            ),
            Argument(
                "-r",
                "--no-run-if-empty",
                action="store_true",
                help="Do not run the command on empty input.",
            ),
            Argument(
                "-s",
                "--max-chars",
                type="str",
                help="Limit a command line to N bytes.",
            ),
            Argument(
                "-t",
                "--verbose",
                action="store_true",
                help="Print each command on stderr before running it.",
            ),
            Argument(
                "--show-limits",
                action="store_true",
                help="Show the command-line length limits.",
            ),
            Argument(
                "-x",
                "--exit",
                action="store_true",
                help="Exit if a command line exceeds the size limit.",
            ),
            Argument(
                "-P",
                "--max-procs",
                type="str",
                help="Run up to N commands at a time; 0 runs "
                "them all at once.",
            ),
            Argument(
                "--process-slot-var",
                type="str",
                help="Set this variable to each command's slot number.",
            ),
            VERSION_OPTION,
            HELP_OPTION,
            Argument("texts", nargs="*", metavar=""),
        ),
    ),
    "timeout": CommandSpec(
        description="Run a command with a time limit.",
        arguments=(
            Argument(
                "-f",
                "--foreground",
                action="store_true",
                help="Signal only the command, not its process group.",
            ),
            Argument(
                "-k",
                "--kill-after",
                type="str",
                help="Also send KILL this long after the first signal.",
            ),
            Argument(
                "-p",
                "--preserve-status",
                action="store_true",
                help="Exit with the command's status even when it times out.",
            ),
            Argument(
                "-s",
                "--signal",
                type="str",
                help="Signal to send on timeout (default TERM).",
            ),
            Argument(
                "-v",
                "--verbose",
                action="store_true",
                help="Report each signal sent on stderr.",
            ),
            HELP_OPTION,
            VERSION_OPTION,
            Argument("texts", nargs="*", metavar=""),
        ),
    ),
    "man": CommandSpec(
        description="Show the manual page of a command.",
        epilog=(
            "Shows the manual page of each PAGE: what the command does, how "
            "to call it and its options. The pages are those of the shell's "
            "own commands, of the commands each mount provides and of the "
            "installed CLIs, where a subcommand has a page of its own, named "
            "after its path with hyphens. Every page is in section 1."
        ),
        arguments=(
            Argument(
                "-a",
                "--all",
                action="store_true",
                help="show every page that matches PAGE",
            ),
            Argument(
                "-f",
                "--whatis",
                action="store_true",
                help="print the summary line of each PAGE",
            ),
            Argument(
                "-k",
                "--apropos",
                action="store_true",
                help="search the names and summaries of every page",
            ),
            Argument(
                "-?",
                "-h",
                "--help",
                action="store_true",
                help="print this list",
            ),
            Argument(
                "--usage", action="store_true", help="print the usage line"
            ),
            Argument("pages", nargs="*", metavar="PAGE"),
        ),
    ),
    "(( ... ))": CommandSpec(
        description=(
            "Evaluate an arithmetic expression.\n\n"
            "Evaluates EXPRESSION with the shell's integer arithmetic, the "
            "same rules `let' follows."
        ),
        epilog="0 when EXPRESSION is not zero, 1 when it is zero.",
    ),
    ".": _SOURCE,
    ":": CommandSpec(
        description=(
            "Do nothing, successfully.\n\n"
            "Expands its arguments and does nothing else."
        ),
        epilog="Always 0.",
    ),
    "[": CommandSpec(
        description=(
            "Evaluate a conditional expression.\n\n"
            "Works as `test' does, but its last argument must be a literal "
            "`]'."
        ),
        epilog=(
            "0 when EXPR is true, 1 when it is false, 2 when it is invalid."
        ),
    ),
    "[[ ... ]]": CommandSpec(
        description=(
            "Evaluate a conditional expression, without word splitting.\n\n"
            "Evaluates EXPRESSION, built from the tests `test' knows, from "
            "`==' and `!=' with a glob pattern on the right, from `=~' "
            "with an extended regular expression on the right, and from "
            "`!', `&&', `||' and parentheses. The words inside are neither "
            "split nor expanded as globs."
        ),
        epilog="0 when EXPRESSION is true, 1 when it is false.",
    ),
    "alias": CommandSpec(
        description=(
            "Define or print aliases.\n\n"
            "With NAME=VALUE, defines an alias: when a command starts with "
            "NAME, the shell reads VALUE in its place. With NAME alone, "
            "prints that alias. With no arguments, prints every alias."
        ),
        epilog="0 unless a NAME has no alias.",
        arguments=(
            Argument(
                "-p",
                action="store_true",
                help="print every alias in a form the shell can read back",
            ),
        ),
    ),
    "break": CommandSpec(
        description=(
            "Leave a for, while, until or select loop.\n\n"
            "Leaves the innermost enclosing loop, or the N-th one out when "
            "N is given."
        ),
        epilog="0 unless N is less than 1.",
    ),
    "case": CommandSpec(
        description=(
            "Run the commands of the first pattern that matches.\n\n"
            "Compares WORD with each PATTERN in turn, using the shell's "
            "glob syntax, and runs the COMMANDS of the first that matches. "
            "`|' separates patterns that lead to the same COMMANDS."
        ),
        epilog=(
            "The status of the last command run, or 0 when no pattern matches."
        ),
    ),
    "cd": CommandSpec(
        description=(
            "Change the working directory.\n\n"
            "Makes DIR the working directory, or $HOME when no DIR is "
            "given. `cd -' goes back to $OLDPWD."
        ),
        epilog="0 when the directory changed, otherwise non-zero.",
        arguments=(
            Argument(
                "-L",
                action="store_true",
                help="keep symbolic links in the new path (the default)",
            ),
            Argument(
                "-P",
                action="store_true",
                help="resolve symbolic links in the new path",
            ),
            Argument(
                "-e",
                action="store_true",
                help="with -P, fail when the new path cannot be resolved",
            ),
            Argument(
                "-@",
                action="store_true",
                help="accepted, with no effect",
            ),
        ),
    ),
    "command": CommandSpec(
        description=(
            "Run a command, passing over shell functions, or describe it.\n\n"
            "Runs COMMAND with its ARGs even when a shell function has the "
            "same name."
        ),
        epilog="The status of COMMAND, or 127 when it cannot be found.",
        arguments=(
            Argument(
                "-p",
                action="store_true",
                help="search a default PATH that finds the standard tools",
            ),
            Argument(
                "-v",
                action="store_true",
                help="print the word or path the shell would run",
            ),
            Argument(
                "-V",
                action="store_true",
                help="describe in words what the shell would run",
            ),
        ),
    ),
    "continue": CommandSpec(
        description=(
            "Start the next pass of a for, while, until or select loop.\n\n"
            "Skips the rest of the innermost enclosing loop's body, or of "
            "the N-th loop out when N is given."
        ),
        epilog="0 unless N is less than 1.",
    ),
    "declare": CommandSpec(
        description=(
            "Set variables and their attributes.\n\n" + _DECLARE_TEXT
        ),
        epilog=_DECLARE_STATUS,
        arguments=_DECLARE_OPTIONS,
    ),
    "disown": CommandSpec(
        description=(
            "Remove jobs from the shell's job table.\n\n"
            "Removes each JOBSPEC, or the current job when none is named, "
            "so the shell no longer reports or waits on it."
        ),
        epilog="0 unless an option or a JOBSPEC is invalid.",
        arguments=(
            Argument("-a", action="store_true", help="remove every job"),
            Argument(
                "-h",
                action="store_true",
                help=(
                    "keep the job, but do not hang it up when the shell exits"
                ),
            ),
            Argument(
                "-r",
                action="store_true",
                help="remove running jobs only",
            ),
        ),
    ),
    "echo": CommandSpec(
        description=(
            "Write the arguments to standard output.\n\n"
            "Prints the ARGs separated by single spaces, then a newline."
        ),
        epilog="0 unless writing fails.",
        arguments=(
            Argument(
                "-n",
                action="store_true",
                help="leave out the final newline",
            ),
            Argument(
                "-e",
                action="store_true",
                help="interpret backslash escapes such as \\n and \\t",
            ),
            Argument(
                "-E",
                action="store_true",
                help="leave backslash escapes as written (the default)",
            ),
        ),
    ),
    "eval": CommandSpec(
        description=(
            "Run the arguments as a command line.\n\n"
            "Joins the ARGs with spaces and runs the result as a command "
            "line in the current shell."
        ),
        epilog="The status of that line, or 0 when it is empty.",
    ),
    "exec": CommandSpec(
        description=(
            "Run a command in place of the shell, or redirect the shell.\n\n"
            "With COMMAND, runs it in place of the shell, so nothing after "
            "it on the line runs. With only redirections, applies them to "
            "the shell itself, for every command that follows."
        ),
        epilog="The status of COMMAND, or 0 when only redirections are given.",
        arguments=(
            Argument(
                "-c",
                action="store_true",
                help="run COMMAND with an empty environment",
            ),
        ),
    ),
    "exit": CommandSpec(
        description=(
            "Leave the shell.\n\n"
            "Ends the shell with status N, or with the status of the last "
            "command when N is not given."
        ),
    ),
    "export": CommandSpec(
        description=(
            "Put variables in the environment of the commands it runs.\n\n"
            "Marks each NAME for export, so every command the shell runs "
            "sees it, and assigns VALUE when one is given. With no NAME, "
            "prints every exported variable."
        ),
        epilog="0 unless an option or a NAME is invalid.",
        arguments=(
            Argument(
                "-f",
                action="store_true",
                help="each NAME is a shell function",
            ),
            Argument(
                "-n",
                action="store_true",
                help="take the export mark off each NAME",
            ),
            Argument(
                "-p",
                action="store_true",
                help="print every exported variable in a reusable form",
            ),
        ),
    ),
    "false": CommandSpec(
        description="Do nothing, unsuccessfully.",
        epilog="Always 1.",
    ),
    "fg": CommandSpec(
        description=(
            "Bring a job to the foreground.\n\n"
            "Makes JOB_SPEC, or the current job, the foreground job and "
            "waits for it."
        ),
        epilog="The status of the job, or failure when JOB_SPEC is invalid.",
    ),
    "for": CommandSpec(
        description=(
            "Run commands once for each word of a list.\n\n"
            "Sets NAME to each of WORDS in turn and runs COMMANDS. Without "
            "`in WORDS', it goes through the positional parameters."
        ),
        epilog="The status of the last command run.",
    ),
    "for ((": CommandSpec(
        description=(
            "Loop under the control of arithmetic expressions.\n\n"
            "Evaluates EXP1 once, then runs COMMANDS and evaluates EXP3 "
            "for as long as EXP2 is not zero. An expression left out "
            "counts as 1."
        ),
        epilog="The status of the last command run.",
    ),
    "function": CommandSpec(
        description=(
            "Define a shell function.\n\n"
            "Makes NAME a command that runs COMMANDS. While it runs, its "
            "arguments are the positional parameters, and `return' ends "
            "it."
        ),
        epilog="0 unless NAME is read-only.",
    ),
    "getopts": CommandSpec(
        description=(
            "Parse options from the arguments.\n\n"
            "Reads the next option from the ARGs, or from the positional "
            "parameters, and puts its letter in NAME. OPTSTRING lists the "
            "letters; one followed by `:' takes a value, which goes in "
            "OPTARG. OPTIND holds the index of the next argument to read. "
            "A `:' at the start of OPTSTRING turns error messages off."
        ),
        epilog=(
            "0 when an option was found, 1 at the end of the options or on "
            "an error."
        ),
    ),
    "help": CommandSpec(
        description=(
            "Show how to use the shell's own commands.\n\n"
            "Shows the commands that match each PATTERN, or lists every "
            "one when no PATTERN is given. A PATTERN matches the names it "
            "begins, or the names it matches as a glob."
        ),
        epilog=(
            "0 unless no command matches a PATTERN or an option is invalid."
        ),
        arguments=(
            Argument(
                "-d",
                action="store_true",
                help="print each command's one-line summary",
            ),
            Argument(
                "-m",
                action="store_true",
                help="print each command's help as a manual page",
            ),
            Argument(
                "-s",
                action="store_true",
                help="print each command's synopsis only",
            ),
        ),
    ),
    "history": SPECS["history"],
    "if": CommandSpec(
        description=(
            "Run commands when a condition holds.\n\n"
            "Runs the `if' COMMANDS and, when they succeed, the `then' "
            "COMMANDS. Otherwise each `elif' is tried in turn, and the "
            "`else' COMMANDS run when none succeeds."
        ),
        epilog="The status of the last command run, or 0 when no branch ran.",
    ),
    "jobs": CommandSpec(
        description=(
            "List the shell's jobs.\n\nLists every job, or the JOBSPECs named."
        ),
        epilog="0 unless an option or a JOBSPEC is invalid.",
        arguments=(
            Argument(
                "-l",
                action="store_true",
                help="add each job's process ID",
            ),
            Argument(
                "-n",
                action="store_true",
                help="only jobs whose state changed since last reported",
            ),
            Argument("-p", action="store_true", help="print process IDs only"),
            Argument("-r", action="store_true", help="running jobs only"),
            Argument("-s", action="store_true", help="stopped jobs only"),
        ),
    ),
    "kill": CommandSpec(
        description=(
            "Send a signal to processes or jobs.\n\n"
            "Sends SIGTERM, or the signal named by an option, to each PID "
            "or JOBSPEC."
        ),
        epilog="0 when every signal was sent.",
        arguments=(
            Argument("-s", metavar="sig", help="the signal to send, by name"),
            Argument(
                "-n",
                metavar="sig",
                help="the signal to send, by number",
            ),
            Argument(
                "-l",
                action="store_true",
                help="list the signal names, or name the numbers given",
            ),
        ),
    ),
    "let": CommandSpec(
        description=(
            "Evaluate arithmetic expressions.\n\n"
            "Evaluates each ARG as an arithmetic expression, in which "
            "variables are named without `$'."
        ),
        epilog="0 when the last ARG is not zero, 1 when it is.",
    ),
    "local": CommandSpec(
        description=(
            "Define variables local to a function.\n\n"
            "Creates each NAME as a variable that lasts only as long as "
            "the function running it, with any option `declare' takes."
        ),
        epilog="0 unless used outside a function or given an invalid NAME.",
    ),
    "mapfile": CommandSpec(
        description=("Read lines into an indexed array.\n\n" + _MAPFILE_TEXT),
        epilog=_MAPFILE_STATUS,
        arguments=_MAPFILE_OPTIONS,
    ),
    "printf": CommandSpec(
        description=(
            "Print arguments under the control of a format.\n\n"
            "Prints the ARGUMENTS as FORMAT describes, using the "
            "conversions printf(1) knows, plus %b, which expands backslash "
            "escapes in its argument, and %q, which quotes its argument "
            "for the shell to read back. FORMAT is used again for as long "
            "as arguments remain."
        ),
        epilog="0 unless an option is invalid or writing fails.",
        arguments=(
            Argument(
                "-v",
                metavar="var",
                help="store the output in VAR instead of printing it",
            ),
        ),
    ),
    "pwd": CommandSpec(
        description="Print the working directory.",
        epilog="0 unless an option is invalid.",
        arguments=(
            Argument(
                "-L",
                action="store_true",
                help="print it as reached, symbolic links kept (the default)",
            ),
            Argument(
                "-P",
                action="store_true",
                help="print it with symbolic links resolved",
            ),
        ),
    ),
    "read": CommandSpec(
        description=(
            "Read one line and split it into fields.\n\n"
            "Reads a line from standard input, splits it at the characters "
            "of $IFS, and assigns the fields to the NAMEs in turn, the "
            "last NAME taking what remains. With no NAME, the line goes "
            "into REPLY."
        ),
        epilog=(
            "0 unless input ends, the read times out, or an option is invalid."
        ),
        arguments=(
            Argument(
                "-a",
                metavar="array",
                help="assign the fields to ARRAY, from index 0",
            ),
            Argument(
                "-d",
                metavar="delim",
                help="read up to DELIM rather than a newline",
            ),
            Argument(
                "-e",
                action="store_true",
                help="accepted, with no effect",
            ),
            Argument("-i", metavar="text", help="accepted, with no effect"),
            Argument(
                "-n",
                metavar="nchars",
                help="stop after NCHARS characters or at the delimiter",
            ),
            Argument(
                "-N",
                metavar="nchars",
                help="read exactly NCHARS characters",
            ),
            Argument(
                "-p",
                metavar="prompt",
                help="print PROMPT on standard error first",
            ),
            Argument(
                "-r",
                action="store_true",
                help="take backslashes literally",
            ),
            Argument(
                "-s",
                action="store_true",
                help="accepted, with no effect",
            ),
            Argument(
                "-t",
                metavar="timeout",
                help="give up after TIMEOUT seconds",
            ),
            Argument("-u", metavar="fd", help="read from file descriptor FD"),
            Argument("texts", nargs="*", metavar=""),
        ),
    ),
    "readarray": CommandSpec(
        description=(
            "Read lines into an indexed array; the same as "
            "`mapfile'.\n\n" + _MAPFILE_TEXT
        ),
        epilog=_MAPFILE_STATUS,
        arguments=_MAPFILE_OPTIONS,
    ),
    "readonly": CommandSpec(
        description=(
            "Make variables read-only.\n\n"
            "Makes each NAME read-only, assigning VALUE first when one is "
            "given. With no NAME, prints every read-only variable."
        ),
        epilog="0 unless an option or a NAME is invalid.",
        arguments=(
            Argument(
                "-a",
                action="store_true",
                help="each NAME is an indexed array",
            ),
            Argument(
                "-A",
                action="store_true",
                help="each NAME is an associative array",
            ),
            Argument(
                "-f",
                action="store_true",
                help="each NAME is a shell function",
            ),
            Argument(
                "-p",
                action="store_true",
                help="print every read-only variable in a reusable form",
            ),
        ),
    ),
    "return": CommandSpec(
        description=(
            "Leave a function or a sourced file.\n\n"
            "Ends the running function or sourced file with status N, or "
            "with the status of the last command when N is not given."
        ),
        epilog="N, or failure when no function or sourced file is running.",
    ),
    "select": CommandSpec(
        description=(
            "Choose words from a numbered menu.\n\n"
            "Prints WORDS as a numbered menu on standard error, then reads "
            "a line from standard input. NAME gets the word chosen, REPLY "
            "the line, and COMMANDS run; then the menu comes back, until "
            "`break' or the end of input."
        ),
        epilog="The status of the last command run.",
    ),
    "set": CommandSpec(
        description=(
            "Set shell options and positional parameters.\n\n"
            "With no arguments, prints every shell variable. Each option "
            "turns a behaviour on with `-' and off with `+'. The ARGs that "
            "follow become the positional parameters.\n\n"
            "After `--', the ARGs are the positional parameters even when "
            "they begin with a dash, and with no ARG the positional "
            "parameters are unset. A lone `-' ends the options too, and "
            "turns -v and -x off."
        ),
        epilog="0 unless an option is invalid.",
        arguments=(
            Argument(
                "-a",
                action="store_true",
                help="export every variable that is assigned",
            ),
            Argument(
                "-b",
                action="store_true",
                help="report finished jobs at once",
            ),
            Argument(
                "-e",
                action="store_true",
                help="leave the shell when a command fails",
            ),
            Argument(
                "-f",
                action="store_true",
                help="turn off pathname expansion",
            ),
            Argument(
                "-h",
                action="store_true",
                help="remember where commands are found",
            ),
            Argument(
                "-k",
                action="store_true",
                help="take assignments anywhere in a command's words",
            ),
            Argument("-m", action="store_true", help="turn on job control"),
            Argument(
                "-n",
                action="store_true",
                help="read commands without running them",
            ),
            Argument(
                "-o",
                metavar="name",
                help="turn on the option called NAME",
            ),
            Argument("-p", action="store_true", help="privileged mode"),
            Argument(
                "-t",
                action="store_true",
                help="leave after one command",
            ),
            Argument(
                "-u",
                action="store_true",
                help="treat an unset variable as an error",
            ),
            Argument(
                "-v",
                action="store_true",
                help="print each line as it is read",
            ),
            Argument(
                "-x",
                action="store_true",
                help="print each command as it runs",
            ),
            Argument(
                "-B",
                action="store_true",
                help="turn on brace expansion",
            ),
            Argument(
                "-C",
                action="store_true",
                help="refuse to overwrite files with `>'",
            ),
            Argument(
                "-E",
                action="store_true",
                help="pass the ERR trap on to functions",
            ),
            Argument(
                "-H",
                action="store_true",
                help="turn on `!' history expansion",
            ),
            Argument(
                "-P",
                action="store_true",
                help="resolve symbolic links when changing directory",
            ),
            Argument(
                "-T",
                action="store_true",
                help="pass the DEBUG and RETURN traps on to functions",
            ),
        ),
    ),
    "shift": CommandSpec(
        description=(
            "Shift the positional parameters.\n\n"
            "Drops the first N positional parameters, 1 by default, and "
            "renumbers the rest from 1."
        ),
        epilog="0 unless N is negative or larger than $#.",
    ),
    "shopt": CommandSpec(
        description=(
            "Set and unset shell options.\n\n"
            "Turns each OPTNAME on or off, or prints its state. With no "
            "OPTNAME, prints every option."
        ),
        epilog=(
            "When printing, 0 when every OPTNAME is on; otherwise 0 unless "
            "an OPTNAME is invalid."
        ),
        arguments=(
            Argument(
                "-o",
                action="store_true",
                help="each OPTNAME is an option of `set -o'",
            ),
            Argument(
                "-p",
                action="store_true",
                help="print in a reusable form",
            ),
            Argument(
                "-q",
                action="store_true",
                help="print nothing; the status tells",
            ),
            Argument("-s", action="store_true", help="turn each OPTNAME on"),
            Argument("-u", action="store_true", help="turn each OPTNAME off"),
        ),
    ),
    "source": _SOURCE,
    "test": CommandSpec(
        description=(
            "Evaluate a conditional expression.\n\n"
            "Evaluates EXPR, made of file tests such as -e, -f, -d, -r, "
            "-w, -x and -s, string tests (-z, -n, = and !=) and integer "
            "comparisons (-eq, -ne, -lt, -le, -gt and -ge), joined with "
            "`!', -a and -o."
        ),
        epilog=(
            "0 when EXPR is true, 1 when it is false, 2 when it is invalid."
        ),
    ),
    "time": CommandSpec(
        description=(
            "Report how long a pipeline takes.\n\n"
            "Runs PIPELINE, then prints the real time it took and the user "
            "and system time it used on standard error."
        ),
        epilog="The status of PIPELINE.",
        arguments=(
            Argument(
                "-p",
                action="store_true",
                help="print the times in the portable format",
            ),
        ),
    ),
    "trap": CommandSpec(
        description=(
            "Run commands when the shell meets signals or events.\n\n"
            "Runs ARG when a SIGNAL_SPEC arrives. An empty ARG ignores the "
            "signals; `-' puts back what they did before. EXIT runs as the "
            "shell leaves, ERR after a command fails, DEBUG before each "
            "command and RETURN as a function or sourced file ends."
        ),
        epilog="0 unless a SIGNAL_SPEC is invalid.",
        arguments=(
            Argument(
                "-l",
                action="store_true",
                help="list the signal names and numbers",
            ),
            Argument(
                "-p",
                action="store_true",
                help="print the traps that are set",
            ),
        ),
    ),
    "true": CommandSpec(
        description="Do nothing, successfully.",
        epilog="Always 0.",
    ),
    "type": CommandSpec(
        description=(
            "Tell how the shell would run a name.\n\n"
            "Tells, for each NAME, whether it is an alias, a keyword, a "
            "function, a builtin or a file, and where."
        ),
        epilog="0 when every NAME is found.",
        arguments=(
            Argument(
                "-a",
                action="store_true",
                help="every place NAME is found, not only the first",
            ),
            Argument(
                "-f",
                action="store_true",
                help="pass over shell functions",
            ),
            Argument(
                "-p",
                action="store_true",
                help="print the file NAME runs, if it is one",
            ),
            Argument(
                "-P",
                action="store_true",
                help="print the file NAME would run, searching PATH",
            ),
            Argument(
                "-t",
                action="store_true",
                help=(
                    "print one word: alias, keyword, function, builtin or file"
                ),
            ),
        ),
    ),
    "typeset": CommandSpec(
        description=(
            "Set variables and their attributes; the same as "
            "`declare'.\n\n" + _DECLARE_TEXT
        ),
        epilog=_DECLARE_STATUS,
        arguments=_DECLARE_OPTIONS,
    ),
    "umask": CommandSpec(
        description=(
            "Print or set the file mode creation mask.\n\n"
            "Sets the mask to MODE, in octal or in chmod's symbolic form, "
            "or prints it when no MODE is given."
        ),
        epilog="0 unless MODE or an option is invalid.",
        arguments=(
            Argument(
                "-p",
                action="store_true",
                help="print the mask in a reusable form",
            ),
            Argument(
                "-S",
                action="store_true",
                help="print the mask symbolically",
            ),
        ),
    ),
    "unalias": CommandSpec(
        description="Remove aliases.",
        epilog="0 unless a NAME is not an alias.",
        arguments=(
            Argument("-a", action="store_true", help="remove every alias"),
        ),
    ),
    "unset": CommandSpec(
        description=(
            "Remove variables and functions.\n\n"
            "Removes each NAME, as a variable, or as a function when no "
            "variable has that name."
        ),
        epilog="0 unless a NAME is read-only.",
        arguments=(
            Argument(
                "-f",
                action="store_true",
                help="each NAME is a function",
            ),
            Argument(
                "-v",
                action="store_true",
                help="each NAME is a variable",
            ),
            Argument(
                "-n",
                action="store_true",
                help="remove the reference NAME itself, not what it names",
            ),
        ),
    ),
    "until": CommandSpec(
        description=(
            "Run commands for as long as a condition fails.\n\n"
            "Runs COMMANDS-2 for as long as COMMANDS fail."
        ),
        epilog="The status of the last command run.",
    ),
    "wait": CommandSpec(
        description=(
            "Wait for jobs and return their status.\n\n"
            "Waits for each ID, a process ID or a job spec, and returns "
            "its status. With no ID, waits for every job the shell started "
            "and returns 0. Only a job this shell started can be waited "
            "for."
        ),
        epilog=(
            "The status of the last ID, or failure when an ID or an option "
            "is invalid."
        ),
        arguments=(
            Argument(
                "-f",
                action="store_true",
                help=(
                    "wait until each ID ends, not only until it changes state"
                ),
            ),
            Argument(
                "-n",
                action="store_true",
                help="wait for the next job to end and return its status",
            ),
            Argument(
                "-p",
                metavar="var",
                help="store in VAR the ID whose status is returned",
            ),
        ),
    ),
    "while": CommandSpec(
        description=(
            "Run commands for as long as a condition holds.\n\n"
            "Runs COMMANDS-2 for as long as COMMANDS succeed."
        ),
        epilog="The status of the last command run.",
    ),
    "{ ... }": CommandSpec(
        description=(
            "Run a list of commands as a group.\n\n"
            "Runs COMMANDS in the current shell, so one redirection "
            "applies to all of them."
        ),
        epilog="The status of the last command run.",
    ),
}


@dataclass(frozen=True, slots=True)
class ShellParse:
    """Result of a strict leading-option scan for a shell builtin.

    Wrapper builtins (xargs, timeout) stop option parsing at the first
    operand, since everything after it belongs to the wrapped command;
    the mount-command parser scans the whole line and warns-ignores
    unknown flags, which is wrong on both counts here. The builtin owns
    the error message and exit code (GNU shapes differ per tool), so
    the parse only reports what went wrong.

    Args:
        flags (dict[str, str | bool]): parsed options keyed by their
            dashless short or long name; an optional-value option
            given bare is True.
        given (list[tuple[str, str | bool]]): every option in the order
            it was given, for a builtin whose options act in turn
            (xargs -I, -L and -n cancel one another).
        operands (list[str]): everything from the first non-option on.
        invalid (str | None): unknown option char or long token.
        candidates (tuple[str, ...]): the long options an ambiguous
            abbreviation in ``invalid`` names, in declaration order;
            empty when ``invalid`` names none.
        needs_value (str | None): value option with no value: the short
            char, or the long token with its dashes.
        unexpected_value (str | None): a no-argument long option given a
            value, as its full spelling and the value (``--null=x``).
    """

    flags: dict[str, str | bool] = field(default_factory=dict)
    given: list[tuple[str, str | bool]] = field(default_factory=list)
    operands: list[str] = field(default_factory=list)
    invalid: str | None = None
    candidates: tuple[str, ...] = ()
    needs_value: str | None = None
    unexpected_value: str | None = None


def parse_shell_options(spec: CommandSpec, argv: list[str]) -> ShellParse:
    """Scan leading options the way getopt does for a shell builtin.

    An optional-value option takes its value only when attached
    (``-iR``, ``--replace=R``), as getopt's ``::`` does, and a long
    option may be abbreviated to any prefix that names one option, as
    getopt_long reads it; an empty name (``--=x``) prefixes every one.

    Args:
        spec (CommandSpec): options table (SHELL_SPECS entry).
        argv (list[str]): builtin arguments, command name excluded.
    """
    short_bool: set[str] = set()
    short_value: set[str] = set()
    short_optional: set[str] = set()
    long_bool: set[str] = set()
    long_value: set[str] = set()
    long_optional: set[str] = set()
    alias: dict[str, str] = {}
    for opt in compile_spec(spec).options:
        _, long = option_spellings(opt)
        shorts = [n[1:] for n in opt.names if not n.startswith("--")]
        long = long.lstrip("-") if long else None
        name = next(iter(shorts), long or "")
        for short in shorts:
            (
                short_bool
                if opt.action in ("store_true", "count")
                else short_optional
                if opt.nargs == "?"
                else short_value
            ).add(short)
            alias[short] = name
        if long is not None:
            (
                long_bool
                if opt.action in ("store_true", "count")
                else long_optional
                if opt.nargs == "?"
                else long_value
            ).add(long)
            alias[long] = name
    compiled = compile_spec(spec)
    flags: dict[str, str | bool] = {}
    given: list[tuple[str, str | bool]] = []

    def record(key: str, value: str | bool) -> None:
        flags[key] = value
        given.append((key, value))

    i = 0
    while i < len(argv):
        tok = argv[i]
        if tok == "--":
            i += 1
            break
        if tok.startswith("--") and len(tok) > 2:
            typed, eq, value = tok.partition("=")
            matches = (
                compiled.long_spellings
                if typed == "--"
                else expand_long(compiled, typed)
            )
            if len(matches) != 1:
                return ShellParse(
                    flags=flags,
                    given=given,
                    operands=list(argv[i + 1 :]),
                    invalid=tok,
                    candidates=tuple(matches),
                )
            name = matches[0][2:]
            if name in long_bool:
                if eq:
                    return ShellParse(
                        flags=flags,
                        given=given,
                        operands=list(argv[i + 1 :]),
                        unexpected_value=f"--{name}={value}",
                    )
                record(alias[name], True)
            elif name in long_optional:
                record(alias[name], value if eq else True)
            elif name in long_value:
                if eq:
                    record(alias[name], value)
                elif i + 1 < len(argv):
                    i += 1
                    record(alias[name], argv[i])
                else:
                    return ShellParse(
                        flags=flags,
                        given=given,
                        operands=list(argv[i + 1 :]),
                        needs_value=f"--{name}",
                    )
            i += 1
            continue
        if tok.startswith("-") and len(tok) > 1:
            chars = tok[1:]
            j = 0
            while j < len(chars):
                ch = chars[j]
                if ch in short_bool:
                    record(alias[ch], True)
                    j += 1
                    continue
                if ch in short_optional:
                    record(alias[ch], chars[j + 1 :] or True)
                    break
                if ch in short_value:
                    rest = chars[j + 1 :]
                    if rest:
                        record(alias[ch], rest)
                    elif i + 1 < len(argv):
                        i += 1
                        record(alias[ch], argv[i])
                    else:
                        return ShellParse(
                            flags=flags,
                            given=given,
                            operands=list(argv[i + 1 :]),
                            needs_value=ch,
                        )
                    break
                return ShellParse(
                    flags=flags,
                    given=given,
                    operands=list(argv[i + 1 :]),
                    invalid=ch,
                )
            i += 1
            continue
        break
    return ShellParse(flags=flags, given=given, operands=list(argv[i:]))
