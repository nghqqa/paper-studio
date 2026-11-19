#!/bin/sh
# Paper Studio container entrypoint: prepare persistent data directories.
set -e
PROJECTS="${PAPER_STUDIO_PROJECTS_DIR:-${PATENT_PROJECTS_DIR:-/data/projects}}"
mkdir -p "$PROJECTS" /data/.cache
echo "[paper-studio] data dir ready: $PROJECTS"
exec "$@"
