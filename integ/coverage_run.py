"""Run a script under branch coverage, save, and exit without teardown.

Usage: python integ/coverage_run.py SOURCES SCRIPT [ARGS...]

SOURCES is a comma-separated list of packages to measure. The data is
saved once the script ends, and the process then leaves through
os._exit: on 3.14 a third-party extension segfaults in the interpreter's
teardown, after the battery has passed and the data is saved, which
would turn a passing run into a failure.
"""

import os
import runpy
import sys

import coverage


def main() -> int:
    sources, script, *args = sys.argv[1:]
    measured = coverage.Coverage(branch=True, source=sources.split(","))
    sys.argv = [script, *args]
    measured.start()
    try:
        runpy.run_path(script, run_name="__main__")
        status = 0
    except SystemExit as exc:
        if isinstance(exc.code, str):
            print(exc.code, file=sys.stderr)
        status = exc.code if isinstance(exc.code, int) else int(bool(exc.code))
    finally:
        measured.stop()
        measured.save()
    return status


if __name__ == "__main__":
    code = main()
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code)
