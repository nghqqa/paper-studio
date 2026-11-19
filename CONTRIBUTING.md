# 贡献指南 / Contributing to Paper Studio

感谢关注并参与 **Paper Studio（研稿）** 的开源建设！

## 开发环境搭建

- **后端（Python 3.11+ / uv）**：
  ```bash
  cd backend
  uv sync
  ```
- **前端（Node 22+ / pnpm 10）**：
  ```bash
  cd frontend
  pnpm install --frozen-lockfile
  ```
  > 注意：前端请务必使用 `pnpm`（不要用 `npm`），以锁定 `pnpm-lock.yaml` 中的依赖版本。
- **Windows 行尾设置**：建议设置 `git config core.autocrlf false`，避免破坏 LF 字节级测试。

## 提交前验证

```bash
# 前端类型检查、构建与测试
pnpm --dir frontend exec tsc -b --force
pnpm --dir frontend build
pnpm --dir frontend test

# 后端核心测试
cd backend && PYTHONPATH=src uv run pytest tests/test_word_editor.py tests/test_paper_templates_admin.py tests/test_word_preflight.py -q

# ONLYOFFICE 插件测试
node --test backend/app/office_plugin/tests/*.test.cjs

# 开源卫生与脱敏扫描
python scripts/export_oss.py --audit-only
```

## 核心设计契约（请务必遵守）

1. **AI 安全契约**：所有 AI 写作/润色/修错路径必须产出差异提案（Proposal），经作者显式确认后才写入正文，绝不静默覆盖稿件。
2. **凭据零泄漏**：任何 API Key、Git PAT、Zotero Key 均不得明文回传前端或写入工程导出包。
3. **许可红线**：不接受将 GPL/AGPL 代码、数据或 Prompt 拷贝进入本项目运行时源码树；内置模板必须附带清晰许可来源。

## 许可证

所有合入本仓库的贡献默认按 **Apache-2.0** 协议发布。
