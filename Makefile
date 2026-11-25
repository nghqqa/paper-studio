.PHONY: help install fonts dev dev-backend dev-frontend build serve lint typecheck test test-frontend check docker-up docker-down clean

help:
	@echo "make install        安装后端(uv)与前端(pnpm)依赖，并安装字体别名到 ~/.config/fontconfig"
	@echo "make fonts          安装 fontconfig 别名（宋体/黑体→OFL 替身）"
	@echo "make dev            同时启动后端 :8000 与前端 :5173（Ctrl+C 停止）"
	@echo "make build          前端生产构建 → frontend/dist（后端自动托管）"
	@echo "make serve          以生产方式单进程启动（后端托管 frontend/dist）"
	@echo "make lint           ruff + oxlint + lint-tokens（设计 token 禁令）"
	@echo "make typecheck      tsc -b"
	@echo "make test           pytest 后端测试"
	@echo "make test-frontend  vitest 前端测试"
	@echo "make check          lint + typecheck + test + test-frontend + build（本地验收全绿）"
	@echo "make docker-up      docker compose up --build -d"

install: fonts
	cd backend && uv sync
	cd frontend && pnpm install

fonts:
	mkdir -p ~/.config/fontconfig/conf.d && cp docker/fonts-cjk-alias.conf ~/.config/fontconfig/conf.d/64-paper-studio-cjk-alias.conf && (fc-cache -f >/dev/null 2>&1 || true)

dev:
	@trap 'kill 0' INT TERM; \
	(cd backend && uv run uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload) & \
	(cd frontend && pnpm dev) & \
	wait

dev-backend:
	cd backend && uv run uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload

dev-frontend:
	cd frontend && pnpm dev

build:
	cd frontend && pnpm build

serve: build
	cd backend && uv run uvicorn app.main:app --host 0.0.0.0 --port 8000

lint:
	cd backend && uv run ruff check app tests
	cd frontend && pnpm lint

typecheck:
	cd frontend && pnpm exec tsc -b

test:
	cd backend && uv run pytest -q

test-frontend:
	cd frontend && pnpm vitest run

check: lint typecheck test test-frontend build
	@echo "✅ 本地验收全绿"

docker-up:
	docker compose up --build -d

docker-down:
	docker compose down

clean:
	rm -rf frontend/dist examples/*/.studio
