# Mirage sandbox base image, built from the repo checkout so it always
# matches the code under test (no release required).
#
#   docker build -f docker/sandbox/Dockerfile --target fuse \
#     -t mirage-python-fuse .
#
# This shared image uses the Python Mirage CLI to serve workspace mounts
# inside the sandbox. Either the Python or TypeScript SDK can control it
# from the host; the SDK language does not select the guest's implementation.
# Install any additional programs your captured commands need in a derived
# image, such as Node.js for commands that invoke node.
#
# The fuse target installs the `sandbox` extra: every mountable backend
# plus fuse3, so one image can FUSE-mount whatever backend a workspace
# declares, not just S3. It deliberately excludes the agent frameworks
# and the sandbox-provider SDKs (daytona/e2b) that `all` pulls in: a
# sandbox is a filesystem host, it never builds agents or launches other
# sandboxes. Usable as-is for local docker (run with --cap-add SYS_ADMIN
# --device /dev/fuse), for Apple's container (`container build` with the
# same flags, run with --cap-add SYS_ADMIN), as a Daytona image/snapshot
# source, and as an E2B template base.
#
# Narrow the extras to just the backends you mount for a leaner image:
#   docker build -f docker/sandbox/Dockerfile --target fuse \
#     --build-arg MIRAGE_EXTRAS=s3,postgres -t mirage-fuse-lean .
# Or extend this image as a base: FROM mirage-python-fuse, then
# pip install any additional extra.

# mirage-ai's native module compiles from rust/ in this stage, on the
# toolchain rust/rust-toolchain.toml pins, so the image carries the wheel
# and not the compiler.
FROM python:3.12-slim AS wheel

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/*

COPY rust /src/rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y \
      --profile minimal \
      --default-toolchain "$(sed -n 's/^channel = "\(.*\)"$/\1/p' /src/rust/rust-toolchain.toml)"
ENV PATH=/root/.cargo/bin:$PATH

COPY python /src/python
RUN pip wheel --no-cache-dir --no-deps --wheel-dir /wheels /src/python

FROM python:3.12-slim AS fuse

ARG MIRAGE_EXTRAS=sandbox

RUN apt-get update \
    && apt-get install -y --no-install-recommends fuse3 libfuse3-dev \
    && rm -rf /var/lib/apt/lists/* \
    && echo user_allow_other >> /etc/fuse.conf

COPY --from=wheel /wheels /wheels
RUN pip install --no-cache-dir "$(ls /wheels/mirage_ai-*.whl)[${MIRAGE_EXTRAS},fuse]" \
    && rm -rf /wheels
