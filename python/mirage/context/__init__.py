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

from mirage.context.session_context import (  # isort: skip
    DEFAULT_UMASK, dotglob_active, effective_mount_mode, effective_path_mode,
    get_admission, get_current_session, get_current_session_for,
    get_mount_gate, get_op_policies, hidden_paths_active,
    hidden_paths_intersect, path_allowed, path_rules_active, readonly_below,
    clear_program_invocation, program_invocation, redirect_paths_for,
    redirect_target_judged, require_mount_writable, reset_program_invocation,
    set_program_invocation, reset_admission, reset_current_session,
    reset_mount_gate, reset_op_policies, reset_redirect_paths,
    session_path_allowed, session_umask, set_admission, set_current_session,
    set_mount_gate, set_op_policies, set_redirect_paths, strongest_mode_under,
    suspend_op_policies)

__all__ = [
    "DEFAULT_UMASK",
    "dotglob_active",
    "effective_mount_mode",
    "effective_path_mode",
    "get_admission",
    "clear_program_invocation",
    "get_current_session",
    "program_invocation",
    "reset_program_invocation",
    "set_program_invocation",
    "get_current_session_for",
    "get_mount_gate",
    "get_op_policies",
    "hidden_paths_active",
    "hidden_paths_intersect",
    "path_allowed",
    "path_rules_active",
    "readonly_below",
    "redirect_paths_for",
    "redirect_target_judged",
    "require_mount_writable",
    "reset_admission",
    "reset_mount_gate",
    "reset_op_policies",
    "reset_redirect_paths",
    "session_path_allowed",
    "session_umask",
    "reset_current_session",
    "set_admission",
    "set_current_session",
    "set_mount_gate",
    "set_op_policies",
    "set_redirect_paths",
    "strongest_mode_under",
    "suspend_op_policies",
]
