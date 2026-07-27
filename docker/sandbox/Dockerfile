# Mirage sandbox base image, built from the repo checkout so it always
# matches the code under test (no release required).
#
#   docker build -f docker/sandbox/Dockerfile --target fuse \
#     -t mirage-python-fuse .
#
# The fuse target installs the `sandbox` extra: every mountable backend
# plus fuse3, so one image can FUSE-mount whatever backend a workspace
# declares, not just S3. It deliberately excludes the agent frameworks
# and the sandbox-provider SDKs (daytona/e2b) that `all` pulls in: a
# sandbox is a filesystem host, it never builds agents or launches other
# sandboxes. Usable as-is for local docker (run with --cap-add SYS_ADMIN
# --device /dev/fuse), as a Daytona image/snapshot source, and as an E2B
# template base.
#
# Narrow the extras to just the backends you mount for a leaner image:
#   docker build -f docker/sandbox/Dockerfile --target fuse \
#     --build-arg MIRAGE_EXTRAS=s3,postgres -t mirage-fuse-lean .
# Or extend this image as a base: FROM mirage-python-fuse, then
# pip install any additional extra.

FROM python:3.12-slim AS fuse

ARG MIRAGE_EXTRAS=sandbox

RUN apt-get update \
    && apt-get install -y --no-install-recommends fuse3 libfuse3-dev \
    && rm -rf /var/lib/apt/lists/* \
    && echo user_allow_other >> /etc/fuse.conf

COPY python /src/python
RUN pip install --no-cache-dir "/src/python[${MIRAGE_EXTRAS},fuse]" && rm -rf /src
