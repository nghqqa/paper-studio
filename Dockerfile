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
        texlive-xetex texlive-luatex texlive-latex-recommended texlive-latex-extra \
        texlive-fonts-recommended texlive-lang-chinese texlive-bibtex-extra \
        texlive-science texlive-pictures biber lmodern \
        latexdiff latexmk pandoc git poppler-utils curl fontconfig \
    && rm -rf /var/lib/apt/lists/*

# Map common CJK font names (SimSun/SimHei/FangSong/KaiTi) to bundled open-source Fandol fonts
COPY docker/fonts-cjk-alias.conf /etc/fonts/conf.d/65-cjk-alias.conf
RUN mkdir -p /usr/local/share/fonts && \
    if [ -d /usr/share/texlive/texmf-dist/fonts/opentype/public/fandol ]; then \
      ln -sf /usr/share/texlive/texmf-dist/fonts/opentype/public/fandol /usr/local/share/fonts/fandol; \
    fi && \
    fc-cache -f || true

RUN echo "paper-runtime: xelatex=$(xelatex --version | head -1 | awk '{print $NF}') " \
         "lualatex=$(lualatex --version | head -1 | awk '{print $NF}') " \
         "biber=$(biber --version 2>/dev/null | head -1 | awk '{print $NF}') " \
         "latexmk=$(latexmk --version 2>/dev/null | grep -o 'Version [0-9.]*') " \
         "pandoc=$(pandoc --version | head -1 | awk '{print $NF}')" > /etc/paper-toolchain.txt

ARG PYPI_MIRROR=
RUN pip install --no-cache-dir -i "${PYPI_MIRROR:-https://pypi.org/simple}" "uv==0.8.*"
WORKDIR /app/backend
COPY --chown=1000:1000 backend/pyproject.toml backend/uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    UV_INDEX_URL="${PYPI_MIRROR:-https://pypi.org/simple}" UV_HTTP_TIMEOUT=600 \
    uv sync --frozen --no-dev
COPY --chown=1000:1000 backend/ ./
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
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
