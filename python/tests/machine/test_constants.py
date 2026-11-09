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

import hashlib
import os
import shutil
import subprocess
import time
import uuid
from pathlib import Path

import pytest

from mirage.machine.constants import (
    ENCODE_OUTPUT,
    JOB_REFUSED_STATUS,
    JOB_REMOVE,
    JOB_START,
    JOB_VIEW,
    MOUNT_GUARD,
    NOT_RUNNING_STATUS,
    PROCESS,
    SETSID_PROBE,
    TOOLS_PATH,
    decode_output,
    mount_field,
    signal_line,
    stop_line,
    wrap_line,
)

PRELUDE = '/bin/sh -c \'CDPATH= cd -- "$1" || exit 126; shift; exec "$@"\' sh '


@pytest.mark.parametrize(
    ("argv", "env", "cwd", "wrapped"),
    [
        (
            ("echo", "hi"),
            {"A": "1"},
            "/w",
            f"{PRELUDE}'/w' env 'A=1' 'echo' 'hi'",
        ),
        (
            ("/bin/sh", "-c", "echo 'hi'"),
            {"M": "two words"},
            "/a b",
            f"{PRELUDE}'/a b' env 'M=two words' '/bin/sh' '-c' "
            "'echo '\\''hi'\\'''",
        ),
        (("pwd",), {}, "/", f"{PRELUDE}'/' env 'pwd'"),
    ],
    ids=["cwd-env-argv", "hostile-values", "no-env"],
)
def test_wrap_line_dresses_cwd_env_and_argv(argv, env, cwd, wrapped):
    assert wrap_line(argv, env, cwd) == wrapped


def test_the_wrapped_argv_reaches_the_program_unchanged(tmp_path):
    argv = ("/bin/sh", "-c", 'printf "[%s]\\n" "$@"', "sh", "a b", "$(x)", "")
    done = subprocess.run(
        ["/bin/sh", "-c", wrap_line(argv, {}, str(tmp_path))],
        capture_output=True,
        check=False,
    )
    assert (done.returncode, done.stdout) == (0, b"[a b]\n[$(x)]\n[]\n")


def test_a_path_without_sh_still_runs_the_line(tmp_path):
    wrapped = wrap_line(
        ("/bin/sh", "-c", "/bin/echo ok"),
        {"PATH": str(tmp_path)},
        str(tmp_path),
    )
    done = subprocess.run(
        ["/bin/sh", "-c", wrapped], capture_output=True, check=False
    )
    assert (done.returncode, done.stdout) == (0, b"ok\n")


# A box that holds no process of the run says so, apart from one whose
# processes it stopped.
@pytest.mark.skipif(not os.path.isdir("/proc/self"), reason="needs /proc")
def test_the_stop_line_answers_a_run_it_does_not_hold():
    done = subprocess.run(
        ["/bin/sh", "-c", stop_line(uuid.uuid4().hex)], check=False, timeout=10
    )
    assert done.returncode == NOT_RUNNING_STATUS


# A run's program may ignore TERM, and the config may set a PATH that
# holds no grep: the stop line still ends every process of the run.
@pytest.mark.skipif(not os.path.isdir("/proc/self"), reason="needs /proc")
@pytest.mark.parametrize("path", [None, "/nowhere"], ids=["path", "no-grep"])
def test_the_stop_line_ends_a_run_that_ignores_term(path):
    tag = f"{uuid.uuid4().hex}:9"
    program = subprocess.Popen(
        [
            "/bin/sh",
            "-c",
            'trap "" TERM; echo ready; while :; do sleep 1; done',
        ],
        env={**os.environ, PROCESS: tag},
        stdout=subprocess.PIPE,
    )
    assert program.stdout is not None
    try:
        assert program.stdout.readline() == b"ready\n"
        done = subprocess.run(
            ["/bin/sh", "-c", stop_line(tag)],
            env=dict(os.environ) if path is None else {"PATH": path},
            check=False,
            timeout=10,
        )
        assert done.returncode == 0
        assert program.wait(timeout=5) == -9
    finally:
        if program.poll() is None:
            program.kill()
        program.stdout.close()


# A tag names one process: the stop line for w:9 leaves the run of w:90
# running.
@pytest.mark.skipif(not os.path.isdir("/proc/self"), reason="needs /proc")
def test_the_stop_line_matches_its_process_tag_whole():
    workspace = uuid.uuid4().hex
    program = subprocess.Popen(
        ["/bin/sh", "-c", "echo ready; while :; do sleep 1; done"],
        env={**os.environ, PROCESS: f"{workspace}:90"},
        stdout=subprocess.PIPE,
    )
    assert program.stdout is not None
    try:
        assert program.stdout.readline() == b"ready\n"
        done = subprocess.run(
            ["/bin/sh", "-c", stop_line(f"{workspace}:9")],
            check=False,
            timeout=10,
        )
        assert done.returncode == NOT_RUNNING_STATUS
        assert program.poll() is None
    finally:
        program.kill()
        program.wait(timeout=5)
        program.stdout.close()


def guarded(table, *entries):
    return subprocess.run(
        ["/bin/sh", "-c", MOUNT_GUARD, "sh", str(table), *entries]
        + ["--", "/bin/echo", "ran"],
        capture_output=True,
        env={"PATH": "/nowhere"},
        check=False,
        timeout=10,
    )


def expected(prefix, source, kind):
    return (
        mount_field(prefix),
        mount_field(source, source=True),
        kind,
        f"lost {prefix}",
    )


def test_mount_field_escapes_what_the_kernel_escapes():
    assert mount_field("/a b\tc\nd\\e#") == "/a\\040b\\011c\\012d\\134e#"
    assert mount_field("m:/a b#", source=True) == "m:/a\\040b\\043"


# The guard runs the program once every mount it expects is on top, read
# through the kernel's escapes, with only sh's builtins on the PATH.
def test_the_mount_guard_runs_the_program_over_its_mounts(tmp_path):
    table = tmp_path / "mounts"
    table.write_text(
        "mirage-x:/my\\040notes /my\\040notes fuse.sshfs rw 0 0\n"
        "tmpfs /a\\134b tmpfs rw 0 0\n"
    )
    done = guarded(
        table,
        *expected("/my notes", "mirage-x:/my notes", "fuse.sshfs"),
        *expected("/a\\b", "tmpfs", "tmpfs"),
    )
    assert (done.returncode, done.stdout, done.stderr) == (0, b"ran\n", b"")


# The kernel escapes a # in a source, never in a mountpoint; an older mount
# under ours is no matter.
@pytest.mark.parametrize(
    ("rows", "prefix", "source"),
    [
        (
            "mirage-x:/a\\043b /a#b fuse.sshfs rw 0 0\n",
            "/a#b",
            "mirage-x:/a#b",
        ),
        (
            "tmpfs /data tmpfs rw 0 0\nmirage-x:/data /data fuse.sshfs rw 0 0\n",
            "/data",
            "mirage-x:/data",
        ),
    ],
    ids=["hash", "over-an-older-mount"],
)
def test_the_mount_guard_runs_over_the_top_mount(
    tmp_path, rows, prefix, source
):
    table = tmp_path / "mounts"
    table.write_text(rows)
    done = guarded(table, *expected(prefix, source, "fuse.sshfs"))
    assert (done.returncode, done.stdout, done.stderr) == (0, b"ran\n", b"")


# The guard's own names never reach the program's environment.
def test_the_mount_guard_hands_the_program_its_environment(tmp_path):
    table = tmp_path / "mounts"
    table.write_text("mirage-x:/data /data fuse.sshfs rw 0 0\n")
    words = ("t", "f", "s", "m", "k", "o")
    done = subprocess.run(
        ["/bin/sh", "-c", MOUNT_GUARD, "sh", str(table)]
        + list(expected("/data", "mirage-x:/data", "fuse.sshfs"))
        + ["--", "/usr/bin/env"],
        capture_output=True,
        env={"PATH": "/nowhere", **{w: f"keep-{w}" for w in words}},
        check=False,
        timeout=10,
    )
    assert done.returncode == 0
    assert {f"{w}=keep-{w}" for w in words} <= set(
        done.stdout.decode().splitlines()
    )


def test_the_mount_guard_checks_every_mount(tmp_path):
    table = tmp_path / "mounts"
    table.write_text("mirage-x:/data /data fuse.sshfs rw 0 0\n")
    done = guarded(
        table,
        *expected("/data", "mirage-x:/data", "fuse.sshfs"),
        *expected("/a\\b", "tmpfs", "tmpfs"),
    )
    assert (done.returncode, done.stdout, done.stderr) == (
        126,
        b"",
        b"lost /a\\b\n",
    )


@pytest.mark.parametrize(
    "rows",
    [
        "",
        "mirage-y:/data /data fuse.sshfs rw 0 0\n",
        "mirage-x:/data /data tmpfs rw 0 0\n",
        "mirage-x:/data /data fuse.sshfs rw 0 0\ntmpfs /data tmpfs rw 0 0\n",
    ],
    ids=["gone", "another-source", "another-type", "covered"],
)
def test_the_mount_guard_refuses_a_mount_not_on_top(tmp_path, rows):
    table = tmp_path / "mounts"
    table.write_text(rows)
    done = guarded(table, *expected("/data", "mirage-x:/data", "fuse.sshfs"))
    assert (done.returncode, done.stdout, done.stderr) == (
        126,
        b"",
        b"lost /data\n",
    )


def test_the_mount_guard_refuses_without_a_mount_table(tmp_path):
    done = guarded(
        tmp_path / "missing",
        *expected("/data", "mirage-x:/data", "fuse.sshfs"),
    )
    assert (done.returncode, done.stdout, done.stderr) == (
        126,
        b"",
        b"lost /data\n",
    )


# A line the machine's own shell writes (no encoder there) is not base64
# and comes back as it is, between the decoded lines; a blank line adds
# nothing.
def test_decode_output_keeps_a_plain_line_as_it_is():
    text = "YQ==\r\nmirage: no base64\n\nAP8=\n"
    assert decode_output(text) == b"amirage: no base64\n\x00\xff"


# A sandbox without dd or base64 runs nothing: the script says so in
# plain text and exits 127.
def test_a_sandbox_without_the_encoder_runs_nothing(tmp_path):
    script = ENCODE_OUTPUT.replace(TOOLS_PATH, str(tmp_path))
    done = subprocess.run(
        ["/bin/sh", "-c", script, "sh", "/bin/sh", "-c", "echo ran"],
        capture_output=True,
        check=False,
        timeout=10,
    )
    assert (done.returncode, done.stdout, done.stderr) == (
        127,
        b"",
        b"mirage: the machine needs dd and base64 to return output\n",
    )


# The scripts a detached job runs are the same bytes on both hosts:
# TypeScript's constants test pins the same digests.
@pytest.mark.parametrize(
    ("script", "digest"),
    [
        (JOB_START, "86dbfd7d1b776142"),
        (JOB_VIEW, "b1159bcdc7dbf586"),
        (JOB_REMOVE, "7cde63f731a3578a"),
        (SETSID_PROBE, "45361050d388f83b"),
    ],
    ids=["start", "view", "remove", "probe"],
)
def test_the_job_scripts_match_typescripts(script, digest):
    assert hashlib.sha256(script.encode()).hexdigest()[:16] == digest


DETACHES = pytest.mark.skipif(
    not os.path.isdir("/proc/self") or shutil.which("setsid") is None,
    reason="needs /proc and setsid",
)


def _start(folder, tag, *argv):
    return subprocess.run(
        ["/bin/sh", "-c", JOB_START, "sh", str(folder), tag, *argv],
        capture_output=True,
        timeout=20,
    )


def _view(folder, out=0, err=0):
    return subprocess.run(
        [
            "/bin/sh",
            "-c",
            JOB_VIEW,
            "sh",
            str(folder),
            str(out),
            str(err),
            "s",
        ],
        capture_output=True,
        timeout=20,
    )


def _pids(folder):
    return [int(word) for word in (folder / "pid").read_text().split()]


# A job started detached runs with its arguments intact, only its program
# and what it starts carry the tag, and a viewer prints its output from
# the offsets it is given, then the end mark with the exit code.
@DETACHES
def test_a_detached_job_is_viewed_to_its_exit_code(tmp_path):
    folder, tag = tmp_path / "jobs" / "w1:9-ab", f"t{uuid.uuid4().hex}:9"
    started = _start(
        folder,
        tag,
        "sh",
        "-c",
        'echo "arg: $1"; echo e1 >&2; exit 3',
        "x",
        "a b",
    )
    assert started.returncode == 0
    viewed = _view(folder)
    assert viewed.stdout == b"arg: a b\n"
    assert viewed.stderr == b"e1\n\0mirage-job s 3\n"
    assert _view(folder, 5, 3).stdout == b"a b\n"
    assert _view(folder, 5, 3).stderr == b"\0mirage-job s 3\n"


@DETACHES
def test_only_the_detached_program_carries_the_tag(tmp_path):
    folder, tag = tmp_path / "jobs" / "job", f"t{uuid.uuid4().hex}:9"
    assert _start(folder, tag, "sleep", "30").returncode == 0
    program, wrapper, _ = _pids(folder)
    try:
        environ = Path(f"/proc/{program}/environ").read_bytes()
        assert f"{PROCESS}={tag}".encode() in environ.split(b"\0")
        wrapped = Path(f"/proc/{wrapper}/environ").read_bytes()
        assert f"{PROCESS}={tag}".encode() not in wrapped.split(b"\0")
        assert os.getpgid(program) == program
    finally:
        os.kill(program, 9)


# A group stop reaches what the program started, and the wrapper lives on
# to write the code the signal left.
@DETACHES
def test_a_group_stop_leaves_the_exit_code_written(tmp_path):
    folder, tag = tmp_path / "jobs" / "job", f"t{uuid.uuid4().hex}:9"
    assert (
        _start(folder, tag, "sh", "-c", "sleep 30 & sleep 30").returncode == 0
    )
    subprocess.run(["/bin/sh", "-c", signal_line(tag, 15, True)], check=True)
    assert _view(folder).stderr == b"\0mirage-job s 143\n"


# A group stop reaches the children a program that exited left holding its
# output, in the group it led.
@DETACHES
def test_a_group_stop_reaches_children_the_program_left(tmp_path):
    folder, tag = tmp_path / "jobs" / "job", f"t{uuid.uuid4().hex}:9"
    started = _start(folder, tag, "sh", "-c", "(sleep 30; echo late) & exit 7")
    assert started.returncode == 0
    while not (folder / "exit").exists():
        time.sleep(0.05)
    subprocess.run(["/bin/sh", "-c", signal_line(tag, 15, True)], check=True)
    viewed = _view(folder)
    assert (viewed.stdout, viewed.stderr) == (b"", b"\0mirage-job s 7\n")


# A job whose wrapper went with no exit code, or whose folder went, is
# lost; one that never launched ends with the shell's own words.
@DETACHES
def test_a_lost_or_unlaunched_job_ends_as_such(tmp_path):
    folder, tag = tmp_path / "jobs" / "job", f"t{uuid.uuid4().hex}:9"
    assert _start(folder, tag, "sleep", "30").returncode == 0
    program, wrapper, _ = _pids(folder)
    os.kill(wrapper, 9)
    os.kill(program, 9)
    time.sleep(0.3)
    assert _view(folder).stderr == b"\0mirage-job s lost\n"
    assert _view(tmp_path / "none").stderr == b"\0mirage-job s lost\n"
    missing = tmp_path / "jobs" / "missing"
    assert _start(missing, tag, "no-such-program").returncode == 0
    viewed = _view(missing)
    assert b"no-such-program: not found" in viewed.stderr
    assert viewed.stderr.endswith(b"\0mirage-job s 127\n")


# A job's folder is the user's alone: none other reads its output, and a
# folder another user owns above it refuses the start.
@DETACHES
def test_a_job_folder_is_the_users_alone(tmp_path):
    folder, tag = tmp_path / "jobs" / "job", f"t{uuid.uuid4().hex}:9"
    assert _start(folder, tag, "true").returncode == 0
    assert folder.stat().st_mode & 0o077 == 0
    assert (tmp_path / "jobs").stat().st_mode & 0o077 == 0
    if os.geteuid() != 0:
        return
    other = tmp_path / "other"
    other.mkdir()
    os.chown(other, 65534, 65534)
    started = _start(other / "job", tag, "true")
    assert started.returncode == JOB_REFUSED_STATUS
    assert b"no folder of this user's own" in started.stderr


# A job ends once what its program started has stopped too, as an attached
# run ends once every writer closed its output: a child's late output is
# viewed before the end mark.
@DETACHES
def test_a_job_ends_once_what_it_started_stopped(tmp_path):
    folder, tag = tmp_path / "jobs" / "job", f"t{uuid.uuid4().hex}:9"
    program = "(sleep 1; echo late) & echo early; exit 7"
    assert _start(folder, tag, "sh", "-c", program).returncode == 0
    viewed = _view(folder)
    assert viewed.stdout == b"early\nlate\n"
    assert viewed.stderr == b"\0mirage-job s 7\n"


# Folders the user made writable by others before are made the user's
# alone again before the job writes there.
@DETACHES
def test_a_job_folder_s_parents_are_made_private(tmp_path):
    jobs = tmp_path / "jobs"
    jobs.mkdir()
    jobs.chmod(0o777)
    assert (
        _start(jobs / "job", f"t{uuid.uuid4().hex}:9", "true").returncode == 0
    )
    assert jobs.stat().st_mode & 0o777 == 0o700
    assert tmp_path.stat().st_mode & 0o777 == 0o700


# A child that closed its output does not hold the job open, as it would
# not hold an attached run: only one still holding ``out`` or ``err`` does.
@DETACHES
def test_a_child_that_closed_its_output_does_not_hold_the_job(tmp_path):
    folder, tag = tmp_path / "jobs" / "job", f"t{uuid.uuid4().hex}:9"
    program = "sleep 30 </dev/null >/dev/null 2>&1 & exit 7"
    assert _start(folder, tag, "sh", "-c", program).returncode == 0
    began = time.monotonic()
    assert _view(folder).stderr == b"\0mirage-job s 7\n"
    assert time.monotonic() - began < 5
    subprocess.run(["/bin/sh", "-c", stop_line(tag, 9)])
