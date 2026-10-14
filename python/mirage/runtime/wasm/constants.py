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

# What a guest is told when it tries to write to the interpreter's own
# build. Not a permission model: editing the build would change what the
# next run executes, so the mounts are the only writable half.
READONLY_HINT = "interpreter build directory is read-only"

# filetypes
FT_UNKNOWN = 0
FT_CHR = 2
FT_DIR = 3
FT_REG = 4
FT_SYMLINK = 7

# lookupflags: whether a path's trailing symlink is resolved. Unset is
# how a guest spells lstat, so a verb that reads it cannot dereference.
LOOKUP_SYMLINK_FOLLOW = 1

# fstflags for path_filestat_set_times: which stamp the call writes and
# whether the value comes from the argument or from the host clock.
FST_ATIM = 1
FST_ATIM_NOW = 2
FST_MTIM = 4
FST_MTIM_NOW = 8

# path_open oflags
OFLAG_CREAT = 1
OFLAG_DIRECTORY = 2
OFLAG_EXCL = 4
OFLAG_TRUNC = 8

# fdflags
FDFLAG_APPEND = 1

# rights
RIGHT_FD_READ = 1 << 1
RIGHT_FD_WRITE = 1 << 6
ALL_RIGHTS = 2**64 - 1


# Trap in wasm, not by raising from a Python callback: wasmtime-py keeps
# callback exceptions in a process-wide slot, shared by concurrent runs.
TERMINATION_SHIM = """(module
  (import "mirage_wasi" "proc_exit" (func $exit (param i32)))
  (import "mirage_wasi" "poll_oneoff" (func $poll (param i32 i32 i32 i32) (result i32)))
  (func (export "proc_exit") (param $code i32)
    (call $exit (local.get $code)) unreachable)
  (func (export "poll_oneoff") (param i32 i32 i32 i32) (result i32) (local $result i32)
    (local.set $result (call $poll
      (local.get 0) (local.get 1) (local.get 2) (local.get 3)))
    (if (i32.lt_s (local.get $result) (i32.const 0)) (then unreachable))
    (local.get $result)))"""
