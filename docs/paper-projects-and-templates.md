# 论文项目首页与模板

本文记录 2026-10-21 的模板与首页交付。后续能力及验收边界以 [团队交接](team-handoff.md) 和根目录 [README](../README.md) 为准；以下测试数字和环境描述属于当时的验证结果。

论文部署使用独立 `PaperDashboard`，不读取旧专利看板、状态或案件筛选偏好。项目列表按所有项目、我的项目、与我共享、归档、回收站组织；列表显示文档类型、真实所有者、投稿目标、截止日期与修改时间。
搜索覆盖名称、投稿目标、学科；Word/LaTeX 类型筛选独立于旧专利筛选。论文所有者来自项目 ACL，不使用专利案件责任人字段。
项目信息编辑走既有 settings 合并接口，保存 title / submission，不修改稿件内容。投稿日期是计划元数据，不复用专利期限计算。

## 中文期刊 Word 模板

`backend/app/word_templates/jcip/` 保留用户提供的原件、转换后的标准 DOCX 与来源摘要。
用户提供的文件扩展名是 `.docx`，文件头实际是旧版 OLE DOC；已通过本地 ONLYOFFICE Docs 10.0.0.169 转为 DOCX。
`make_document(..., 'jcip')` 返回完整模板文件，不调用 python-docx 重建正文。平台项目名不会替换模板里已排版的论文标题。
此前的 `docx_export_assets/jcip-reference.docx` 是转换时用的参考样式文件，不是期刊原模板，仍只服务于旧转换链路。

原件与转换后 DOCX 在同一个 ONLYOFFICE 服务中分别转成 PDF：均为四页，四页图像逐像素一致。新建项目的初次下载与模板 DOCX 逐字节一致。
模板中的中英文摘要、各页页眉、正文分栏、参考文献和作者照片占位保持原样。
这证明了本次转换和创建链路未新增版式漂移，不等同于所有 Office 版本和字体环境下完全一致。

当前文档服务的 PDF 字体包括 WenQuanYi Zen Hei Mono、Droid Sans Fallback 等替代字体，未复现原件所需的全部方正/宋体系列。
DOCX 保留原字体名称。部署增加 `ONLYOFFICE_FONTS_DIR` 和自动字体清单生成；字体目录说明见 `deploy/paper/fonts/README.md`。
完整复现需服务器及最终打开稿件的电脑具备相同字体。参见 [ONLYOFFICE 字体说明](https://helpcenter.onlyoffice.com/docs/installation/docs-install-fonts-docker.aspx)。

截图中的“公式编号与 DOCX 兼容性验证”是早期公式功能样稿，与本次接入的期刊模板是不同文件。早期编号行使用无打印边框的标准 DOCX 表格。当前新增编号采用普通段落、居中/右对齐制表位和原生 OMML，不新增表格；旧稿中的表格不会被自动改写，需用户显式转换。编号仍是手工文本。

## LaTeX 模板与编译

- 新增 ICLR 2027 官方完整工程（排版指南、样式、数学命令、引用库），实际编译七页。
- ACL 改用官方完整 `acl_latex.tex` 示例，补齐 `custom.bib`；实际编译四页。修复原 `acl_natbib.bst` 被错误保存为 `404: Not Found` 的问题。
- 保留各模板 SOURCES.md 中的官方来源和上游文件 SHA。除末尾空白规范化外，保留完整示例与许可。
- 新建工程使用模板声明的主文件/引擎及投稿目标，不替换既有用户正文。只有精确等于已知 404 下载错误的旧 ACL 样稿样式文件在本地验收中被备份后修复。
- 首次打开没有历史构建、也没有待恢复草稿的可编辑工程时自动编译。切换项目使用独立工作台实例。

本机 MiKTeX 的 latexmk 原先找不到 Perl。`PATENT_STUDIO_LATEX_EXTRA_PATH` 可为编译进程提供额外工具目录，本机使用已有的 Git Perl，不修改全局 PATH。
Windows 本地启动示例：`PATENT_STUDIO_LATEX_EXTRA_PATH=C:\Program Files\Git\usr\bin`。
正式论文镜像已内置 TeX Live 与 latexmk；不需要 Windows 路径。缺少 Perl 时现在显示明确的环境诊断。

## 科研图表

早期首页的科研图表入口仅展示规划，集成设计见 [scientific-figures.md](scientific-figures.md)。后续已实现项目级数据图预览、保存、PNG 下载和 LaTeX 引用片段；Word 插件内部也有数据图生成与插入实现。项目图表库插入 Word 光标、数据修改后同步正文图片等完整流程仍待建设，详见 [团队交接](team-handoff.md)。

## 本地验证

后端 Word/模板回归 22 项通过；前端项目、创建、Word、LaTeX 回归 73 项通过；生产构建与部署配置检查通过。
两个 LaTeX 工程均通过实际编译；期刊模板完成原始 DOC 与 DOCX 的四页视觉对比。
验收报告、PDF 与截图位于忽略目录 `.e2e-downloads/`，不提交用户稿件或字体。
