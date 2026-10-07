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

# The profile a session is created from when none is named and the
# workspace defines one of this name.
DEFAULT_PROFILE = "default"

# What a fork of a session carries over. Written down once because
# `SessionState.fork` builds a copy from it and
# `tests/workspace/session/test_session.py` asserts that every dataclass
# field is either here or in TRANSIENT_FIELDS, so a field added later
# cannot be silently dropped by a hand-written literal the way
# `script_name` was.
INHERITED_FIELDS: tuple[str, ...] = (
    "session_id",
    "cwd",
    "logical_cwd",
    "vars",
    "created_at",
    "functions",
    "readonly_functions",
    "last_exit_code",
    "pipe_status",
    "function_names",
    "shell_options",
    "shopts",
    "aliases",
    "umask",
    "mount_modes",
    "visibility",
    "hide_reasons",
    "commands",
    "script",
    "profile",
    "command_limits",
    "terminal_output",
    "processes",
    "process_id",
    "shell_pid",
    "process_depth",
    "decisions",
    "generation",
    "pipeline_timeout_seconds",
    "last_bg_job_id",
    "positional_args",
    "script_name",
    "exit_trap",
    "exit_trap_inherited",
    "tty",
    "job_output",
    "job_waits",
    "descriptors",
    "exec_stdout",
    "exec_stdout_append",
    "exec_stdout_input",
    "exec_stderr",
    "exec_stderr_append",
    "exec_stderr_input",
    "exec_stdin",
    "exec_stdin_unreadable",
    "exec_stdin_identity",
    "_getopts_pos",
    "_getopts_optind",
)

# State that belongs to the line being executed, not to the shell, so a
# fork starts it fresh: the errexit marker and the running function's
# locals.
TRANSIENT_FIELDS: tuple[str, ...] = (
    "errexit_immune",
    "_local_vars",
    "_local_frames",
    "_local_random",
    "_trap_status",
    "_pipe_status_pending",
    "_random_state",
    "_random_seed",
    "_random_last",
    "_parse_seq",
    "_parse_current",
    "_parse_row",
    "_function_marks",
    "_line_open",
    "terminal",
    "_alias_marks",
    "_alias_stack",
    "status_writer",
)
