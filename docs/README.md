# 研稿文档索引

当前论文产品的入口是根目录 [README](../README.md)。新接手先看团队交接，再按功能查阅；
验收记录保留当时环境与限制，后续章节或后续版本可能已修正早期结论。

## 当前产品与开发

| 路径 | 内容 |
| --- | --- |
| [team-handoff.md](team-handoff.md) | 接手顺序、管理员与模板管理、当前验收边界和后续工作 |
| [word-editor.md](word-editor.md) | ONLYOFFICE 部署、原生 DOCX、公式插件、保存与旧稿迁移 |
| [paper-projects-and-templates.md](paper-projects-and-templates.md) | 论文项目首页、Word / LaTeX 模板、字体与格式兼容性 |
| [../backend/app/office_plugin/README.md](../backend/app/office_plugin/README.md) | 公式插件接口、原生编号、限制与测试方法 |
| [v04-acceptance.md](v04-acceptance.md) | 文献管理、AI 修改提案的 v0.4 实现及验收矩阵 |
| [v041-closeout.md](v041-closeout.md) | 后续 Word 插件、个人 AI 接入、真实模型、SyncTeX、工程文件和域名部署记录 |
| [../deploy/paper/paper.sh](../deploy/paper/paper.sh) / [../deploy/paper/.env.example](../deploy/paper/.env.example) | 论文部署脚本与配置示例 |
| [../deploy/paper/WORD-CONFIG.md](../deploy/paper/WORD-CONFIG.md) | Word 插件浏览器地址与服务间地址分工、迁移和验收 |
| [../deploy/paper/LAB-DEPLOY.md](../deploy/paper/LAB-DEPLOY.md) | 实验室部署与排障 |
| [../deploy/paper/DELIVERY.md](../deploy/paper/DELIVERY.md) / [../deploy/paper/VERSIONS.md](../deploy/paper/VERSIONS.md) | 早期交付数据、镜像台账和回退规则 |

科研图表已有 `ScientificFigures.tsx` 与 `routes/project_figures.py` 的数据图入口。
[scientific-figures.md](scientific-figures.md) 是 2026-10-21 的集成方案，首段“尚未开放”已不是当前代码状态；
Word 插件内也已有数据生成 PNG 后直接插入光标的入口。项目图表库到 Word 工作台的连接、方法图场景和
图源更新流程仍是后续方向。实际交付范围以根 README 与团队交接为准。

## 架构、设计与资料

| 路径 | 内容 |
| --- | --- |
| [../TRANSFORM.md](../TRANSFORM.md) | 从前身产品转为论文平台的方案与依据 |
| [design/](design/) | 各轮专项设计和验证记录，按文档日期及所属产品线阅读 |
| [design-system/](design-system/) | 设计系统 tokens、页面规格和品牌资料 |
| [../design-qa.md](../design-qa.md) | 界面调整的检查记录与待验证项 |
| [../fonts/README.md](../fonts/README.md) | 字体说明 |
| [assets/](assets/) | 文档引用的截图等资源 |

## 前身产品与兼容资料

以下内容为原专利产品及旧架构留下的资料，不作为研稿当前界面、功能或部署契约：

| 路径 | 用途 |
| --- | --- |
| [project-intro.md](project-intro.md) / [user-manual.md](user-manual.md) | 前身产品介绍和操作手册 |
| [deploy.md](deploy.md) / [design.md](design.md) / [mcp.md](mcp.md) | 旧平台服务、存储与 Agent 接入约定；兼容开发时对照代码 |
| [cnipa-xml-research.md](cnipa-xml-research.md) | CNIPA XML 格式调研 |
| [competitive-landscape.md](competitive-landscape.md) / [competitive-landscape-v2.md](competitive-landscape-v2.md) | 历史竞品调研 |
| [figure-type-survey.json](figure-type-survey.json) / [figure-library/](figure-library/) | 旧附图调研、资源与使用边界 |
| [text-corpus/](text-corpus/) / [../examples/](../examples/) | 历史语料、演示数据与重建工具 |
