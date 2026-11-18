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

"""Rebuild the shared ast-grep engine with Rust and a Wasm-capable clang/llvm-ar."""

import argparse
import gzip
import json
import os
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]
CRATE = ROOT / "rust/ast-grep"
ASSET = ROOT / "python/mirage/commands/cli/builtin/ast_grep/engine.wasm.gz"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=pathlib.Path, default=ASSET)
    output = parser.parse_args().output
    target = "wasm32-unknown-unknown"
    metadata = json.loads(
        subprocess.check_output(
            [
                "cargo",
                "metadata",
                "--locked",
                "--format-version",
                "1",
                "--filter-platform",
                target,
            ],
            cwd=CRATE,
        )
    )
    grammar = next(
        p for p in metadata["packages"] if p["name"] == "tree-sitter-language"
    )
    crate = pathlib.Path(grammar["manifest_path"]).parent
    env = dict(os.environ)
    env["CC_SHELL_ESCAPED_FLAGS"] = "1"
    key = "CFLAGS_wasm32_unknown_unknown"
    env[key] = f'{env.get(key, "")} -I"{crate / "wasm/include"}"'.strip()
    result = subprocess.check_output(
        [
            "cargo",
            "rustc",
            "--locked",
            "--release",
            "--target",
            target,
            "--message-format=json-render-diagnostics",
            "--config",
            f"target.{target}.rustflags="
            + json.dumps(
                [
                    f"--remap-path-prefix={crate.parent}=crates",
                    f"--remap-path-prefix={ROOT}=mirage",
                ]
            ),
            "--",
            "-C",
            "link-arg=--import-memory",
            "-C",
            "link-arg=--initial-memory=6291456",
        ],
        cwd=CRATE,
        env=env,
        text=True,
    )
    artifact = next(
        pathlib.Path(path)
        for line in result.splitlines()
        for path in json.loads(line).get("filenames", [])
        if path.endswith(".wasm")
    )
    output.write_bytes(
        gzip.compress(artifact.read_bytes(), compresslevel=9, mtime=0)
    )


if __name__ == "__main__":
    main()
