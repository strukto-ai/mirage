# Mirage sandbox base images, built from the repo checkout so they
# always match the code under test (no release required).
#
#   docker build -f docker/sandbox/Dockerfile --target fuse \
#     -t mirage-python-fuse .
#
# Targets:
#   fuse  - python mirage-ai[s3,fuse] + fuse3 preinstalled: everything
#           the runtimes' mount: fuse mode needs. Usable as-is for
#           local docker (run with --cap-add SYS_ADMIN --device
#           /dev/fuse), as a Daytona image:/snapshot source, and as an
#           E2B template base. A typescript-flavored twin
#           (mirage-typescript-fuse) can join once the in-sandbox
#           mount script has a node variant; today that side always
#           runs python mirage.
#   (a shim target with the serve-mode PATH shims lands with
#   mount: serve.)

FROM python:3.12-slim AS fuse

RUN apt-get update \
    && apt-get install -y --no-install-recommends fuse3 libfuse3-dev \
    && rm -rf /var/lib/apt/lists/* \
    && echo user_allow_other >> /etc/fuse.conf

COPY python /src/python
RUN pip install --no-cache-dir "/src/python[s3,fuse]" && rm -rf /src
