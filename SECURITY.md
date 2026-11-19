# 安全政策 / Security Policy

## 报告漏洞

请通过 **GitHub Security Advisories**（仓库 `Security` 标签页 → `Report a vulnerability`）私下提交安全漏洞报告，请勿在公开 Issue 中直接披露未修复漏洞细节。我们会在 7 天内回复。

## 生产部署安全须知

1. **强制开启鉴权与强密钥**：任何暴露在局域网或公网的实例必须设置 `PAPER_STUDIO_AUTH=on` 与至少 32 位随机 `PAPER_STUDIO_SECRET`（使用 `openssl rand -hex 32` 生成）。
2. **HTTPS 与 Cookie 安全**：经 HTTPS 反向代理对外提供服务时，必须设置 `PAPER_STUDIO_COOKIE_SECURE=on`。
3. **ONLYOFFICE JWT 隔离**：启用 Word 模式时，`ONLYOFFICE_JWT_SECRET` 必须独立于 `PAPER_STUDIO_SECRET` 且在应用与 Document Server 两侧一致。
4. **数据外发边界**：本地写作与 LaTeX 编译默认不向外网发送稿件；配置远端 AI Provider 或外部文献/Zotero 服务后，用户显式选中的内容或查询参数将发往对应服务商，请按所在机构数据合规政策配置。

## 支持版本

安全修复原则上基于 `main` 最新发行版本提供。
