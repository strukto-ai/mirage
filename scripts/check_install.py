from __future__ import annotations

import argparse
import os
import shlex
import shutil
import subprocess
import tempfile
from pathlib import Path

INSTALLER = Path(__file__).resolve().with_name("install.sh")
VERSIONS = {
    "18.20.8": True,
    "20.19.0": True,
    "21.7.3": True,
    "22.19.0": True,
    "22.20.0": False,
    "22.21.0": False,
    "23.11.0": True,
    "24.11.0": True,
    "24.12.0": False,
    "25.0.0": False,
    "26.1.0": False,
}


def script(path: Path, body: str) -> None:
    path.write_text("#!/bin/sh\n" + body)
    path.chmod(0o755)


def check(shell: str) -> None:
    interpreter = shutil.which(shell)
    node = shutil.which("node")
    if interpreter is None or node is None:
        raise RuntimeError("The requested shell and Node.js must be installed")
    with tempfile.TemporaryDirectory(prefix="mirage-install-") as directory:
        root = Path(directory)
        for command in ("uname", "bash", "chmod"):
            executable = shutil.which(command)
            if executable is None:
                raise RuntimeError(f"Required command not found: {command}")
            (root / command).symlink_to(executable)
        script(
            root / "node",
            'if [ "$1" = --version ]; then\n'
            '  printf "v%s\\n" "$INSTALL_TEST_NODE"; exit 0\n'
            "fi\n"
            f"exec {shlex.quote(node)} -e '"
            'Object.defineProperty(process.versions,"node",'
            "{value:process.env.INSTALL_TEST_NODE}); "
            'eval(process.argv[1])\' "$2"\n',
        )
        script(root / "curl", "exit 7\n")
        script(
            root / "npm",
            'printf "%s\\n" "$*" >> "$INSTALL_TEST_ROOT/npm.log"\n'
            'if [ "$1" = prefix ]; then\n'
            '  printf "%s/global\\n" "$INSTALL_TEST_ROOT"\n'
            "fi\n"
            'exit "${INSTALL_TEST_NPM_EXIT:-0}"\n',
        )
        script(root / "mirage", "printf 'test-version\\n'\n")
        env = os.environ | {"PATH": directory, "INSTALL_TEST_ROOT": directory}

        def run() -> subprocess.CompletedProcess[str]:
            return subprocess.run(
                [interpreter, str(INSTALLER)],
                env=env,
                text=True,
                capture_output=True,
                timeout=10,
                check=False,
            )

        for version, warning in VERSIONS.items():
            env["INSTALL_TEST_NODE"] = version
            (root / "npm.log").unlink(missing_ok=True)
            result = run()
            assert result.returncode == 0, result.stderr
            assert (
                "outside the supported versions" in result.stdout
            ) == warning, (
                version,
                result.stdout,
            )
            assert "Mirage installed" in result.stdout
            assert (
                root / "npm.log"
            ).read_text() == "install -g @struktoai/mirage-cli\n"

        env["INSTALL_TEST_NPM_EXIT"] = "1"
        result = run()
        assert (
            result.returncode == 1 and "Global install failed" in result.stdout
        )
        del env["INSTALL_TEST_NPM_EXIT"]

        (root / "mirage").unlink()
        result = run()
        assert (
            result.returncode == 0
            and str(root / "global/bin") in result.stdout
        )
        script(root / "mirage", "printf 'test-version\\n'\n")

        (root / "node").unlink()
        result = run()
        assert (
            result.returncode == 1
            and "Failed to download fnm" in result.stderr
        )

        script(root / "curl", "printf 'exit 9\\n'\n")
        result = run()
        assert result.returncode == 9, result.stderr

        script(
            root / "fnm",
            'case "$1" in\n'
            'install) printf "#!/bin/sh\\nexit 0\\n" > "$INSTALL_TEST_ROOT/node"; '
            'chmod +x "$INSTALL_TEST_ROOT/node";;\n'
            'env) printf \'export PATH="%s:$PATH"\\n\' "$INSTALL_TEST_ROOT";;\n'
            "esac\n",
        )
        result = run()
        assert result.returncode == 0 and "Node.js not found" in result.stdout
        assert "Mirage installed" in result.stdout
        print(f"PASS: {len(VERSIONS) + 5} installer checks under {shell}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--shell", required=True, choices=("sh", "dash", "bash")
    )
    check(parser.parse_args().shell)


if __name__ == "__main__":
    main()
