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

KILLED_EXIT_CODE = 137

# How long a killed job's runner is given to stop what it started (a
# machine stops a run for up to 5 s after a 1 s grace) before its console ends
# with the status the kill recorded.
STOP_WAIT_SECONDS = 10.0

# How many ended jobs' statuses a session keeps for a later `wait` of
# their pid, as bash keeps those of its last children.
SAVED_STATUSES = 1024

# How long ago a lone job must have ended for a bare ``wait`` to find it
# already over, rather than racing the job it has just started.
JUST_ENDED_SECONDS = 0.02

# How long a job's owner waits before watching its console again after a
# read of it failed.
WATCH_RETRY_SECONDS = 1.0

# How often a table that runs jobs checks that their sessions' lists still
# hold them: a list deleted with its workspace ends no console the owner
# could read.
LIST_CHECK_SECONDS = 10.0

# How often a workspace on a shared store publishes the processes it
# runs, and takes the stops other workspaces asked of it, while it runs
# any.
PUBLISH_SECONDS = 1.0

# How long an owner's lease lasts on a store other processes share. The
# owner renews it at a third of that while it runs jobs, so a workspace
# that dies is seen as gone at most this long after its last renewal.
LEASE_SECONDS = 30.0

# The status a job lost with its owner answers: SIGHUP's, as bash's job
# answers when its terminal goes.
HANGUP_EXIT_CODE = 129

# How long a shared console's output is kept after its last write, or
# after its owner last renewed it while the job ran, so the streams of
# jobs nobody reaps, or whose owner died, do not accumulate. How a job ended
# outlives it in the job's list entry.
CONSOLE_TTL_SECONDS = 86400

# How many random bits a newly written job list's generation starts from:
# few enough that every later generation stays an exact JSON number on
# both hosts and in Redis's Lua.
GENERATION_BITS = 52

# How many times a job-list write retries against other writers before
# it gives up: every workspace of a session writes the one record.
LIST_MAX_RETRIES = 32

# What bash starts a background job ignoring when job control is off:
# `kill -INT` or `kill -QUIT` reaches it and nothing happens, and timeout's
# (`-s INT`) stops only the program the job runs right now.
IGNORED_SIGNALS = frozenset({2, 3})

# What ends a builtin's or a function's job (`f &`) with the program it
# runs: bash's shell dies of an INT its child died of, and lives on
# through a QUIT.
ENDING_SIGNALS = frozenset({2})
