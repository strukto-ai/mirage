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
# `Session.fork` builds a copy from it and
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
    "shell_options",
    "shopts",
    "aliases",
    "umask",
    "mount_modes",
    "hidden_paths",
    "shown_paths",
    "hidden_vars",
    "hide_reasons",
    "commands",
    "script",
    "profile",
    "decisions",
    "generation",
    "pipeline_timeout_seconds",
    "last_bg_job_id",
    "positional_args",
    "script_name",
    "exec_stdout",
    "exec_stdout_append",
    "exec_stderr",
    "exec_stderr_append",
    "exec_stdin",
    "exec_stdin_unreadable",
    "exec_stdin_identity",
    "_exec_opened",
    "_getopts_pos",
    "_getopts_optind",
)

# State that belongs to the line being executed, not to the shell, so a
# fork starts it fresh: the errexit marker, the source nesting depth, the
# stdin the caller happened to pass and the running function's locals.
TRANSIENT_FIELDS: tuple[str, ...] = (
    "errexit_immune",
    "source_depth",
    "_stdin_buffer",
    "_stdin_source",
    "_local_vars",
    "_local_frames",
    "_local_random",
    "_cmdsub_seq",
    "_cmdsub_status",
    "_diagnostics",
    "_pipe_status_pending",
    "_random_state",
    "_random_seed",
    "_random_last",
    "_parse_seq",
    "_parse_current",
    "_alias_marks",
    "_alias_stack",
)

# What a child shell gets its own copy of, and the parent gets back
# afterwards. A `( … )` subshell, a nested `bash`/`sh` and each segment
# of a pipeline are all child shells and all read this list, so none can
# drift into isolating a field the others leak. `last_exit_code` is
# deliberately absent: `$?` after a child shell is the child's status,
# which is the one thing it reports back. `pipe_status` is present for
# the pipeline case: every segment sees the statuses of the pipeline
# before this one, however many its own statements run.
CHILD_SHELL_FIELDS: tuple[str, ...] = (
    "cwd",
    "logical_cwd",
    "source_depth",
    "vars",
    "functions",
    "readonly_functions",
    "shell_options",
    "shopts",
    "aliases",
    "umask",
    "positional_args",
    "script_name",
    "last_bg_job_id",
    "exec_stdout",
    "exec_stdout_append",
    "exec_stderr",
    "exec_stderr_append",
    "exec_stdin",
    "exec_stdin_unreadable",
    "exec_stdin_identity",
    "_exec_opened",
    "_getopts_pos",
    "_getopts_optind",
    "_random_state",
    "_random_seed",
    "_random_last",
    "pipe_status",
)
