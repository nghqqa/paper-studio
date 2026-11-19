# syntax=docker/dockerfile:1.7
# Paper Studio (研稿) — All-in-one application image (FastAPI + React + TeXLive + Pandoc)
# Optional Word editing is provided by the separate ONLYOFFICE Docs container (`--profile word`).

# ---------- Stage 1: Frontend build ----------
FROM node:22-alpine AS web
ARG NPM_MIRROR=
WORKDIR /app/frontend
RUN corepack enable && \
    COREPACK_NPM_REGISTRY="${NPM_MIRROR:-https://registry.npmjs.org}" \
    corepack prepare pnpm@10 --activate
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile ${NPM_MIRROR:+--registry=$NPM_MIRROR}
COPY frontend/ ./
# Frontend typecheck/tests reference shared schema & fixtures via relative paths
COPY backend/src/patent_studio/kernel/ast_schema.json /app/backend/src/patent_studio/kernel/ast_schema.json
COPY backend/tests/golden /app/backend/tests/golden
COPY backend/tests/fixtures /app/backend/tests/fixtures
COPY examples/method/studio.json /app/examples/method/studio.json
COPY examples/system/studio.json /app/examples/system/studio.json
RUN pnpm build

# ---------- Stage 2: Runtime (Python + TeXLive + Pandoc) ----------
FROM python:3.11-slim AS runtime
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

ARG APT_MIRROR=
RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
    fi \
    && apt-get update && apt-get install -y --no-install-recommends \
        texlive-xetex texlive-latex-recommended texlive-latex-extra \
        texlive-fonts-recommended texlive-lang-chinese lmodern \
        latexmk pandoc git poppler-utils curl \
    && rm -rf /var/lib/apt/lists/*

RUN echo "paper-runtime: xelatex=$(xelatex --version | head -1 | awk '{print $NF}') " \
         "latexmk=$(latexmk --version 2>/dev/null | grep -o 'Version [0-9.]*') " \
         "pandoc=$(pandoc --version | head -1 | awk '{print $NF}')" > /etc/paper-toolchain.txt

ARG PYPI_MIRROR=
RUN pip install --no-cache-dir -i "${PYPI_MIRROR:-https://pypi.org/simple}" "uv==0.8.*"
WORKDIR /app/backend
COPY --chown=1000:1000 backend/pyproject.toml backend/uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    UV_INDEX_URL="${PYPI_MIRROR:-https://pypi.org/simple}" UV_HTTP_TIMEOUT=600 \
    uv sync --frozen --no-dev --no-install-project
COPY --chown=1000:1000 backend/ ./
RUN --mount=type=cache,target=/root/.cache/uv \
    UV_INDEX_URL="${PYPI_MIRROR:-https://pypi.org/simple}" UV_HTTP_TIMEOUT=600 \
    uv sync --frozen --no-dev
COPY --from=web --chown=1000:1000 /app/frontend/dist /app/frontend/dist

ENV PATH="/app/backend/.venv/bin:$PATH" \
    PAPER_STUDIO_PROJECTS_DIR=/data/projects \
    PAPER_STUDIO_STATIC_DIR=/app/frontend/dist \
    PAPER_STUDIO_PRODUCT=paper \
    HOME=/data

COPY docker/entrypoint-paper.sh /entrypoint-paper.sh
RUN chmod +x /entrypoint-paper.sh && mkdir -p /data/projects && chown -R 1000:1000 /data

VOLUME ["/data"]
EXPOSE 8000
USER 1000
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s \
    CMD curl -fs http://127.0.0.1:8000/api/health || exit 1
ENTRYPOINT ["/entrypoint-paper.sh"]
CMD ["uvicorn", "patent_studio.asgi:app", "--host", "0.0.0.0", "--port", "8000", "--ws-ping-interval", "15", "--ws-ping-timeout", "20"]
