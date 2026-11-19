# vendored CSL 样式

来源：Zotero 官方样式仓库 <https://github.com/citation-style-language/styles>（拉取日期 2026-11-17）。

| 文件 | 仓库内 id | 许可 |
|---|---|---|
| `ieee.csl` | `ieee` | CC BY-SA 3.0（文件内 `<rights>` 声明保留） |
| `springer-lncs.csl` | `springer-lecture-notes-in-computer-science` | CC BY-SA 3.0 |
| `acm.csl` | `association-for-computing-machinery` | CC BY-SA 3.0 |
| `elsevier-vancouver.csl` | `elsevier-vancouver` | CC BY-SA 3.0 |

## 平台准入约束（硬闸门）

新增样式必须同时满足（守卫：`backend/tests/test_csl_styles.py`）：

1. `citation-format="numeric"`（顺序编码制）——author-date 体系不得进入 `word_citations.STYLES`；
2. 经 `citeproc-py` 渲染的 `bibliography()` 条目前缀可被 `word_citations._CSL_LABEL_RE`
   （`[n]` / `n.` / `n)` / `n:`）**干净剥离**，重拼后为单编号 `[n] 作者…`，不得出现 `[1] 1. 作者` 双标号；
3. 正文引文标签恒为 `[n]` 方括号形态（`_render_csl` 用确定性注册序号，见 routes/library.py 注释）。

样式文件是数据（XML）非代码，由 citeproc 解析，无执行面；只从官方仓库拉取并保留许可声明。
