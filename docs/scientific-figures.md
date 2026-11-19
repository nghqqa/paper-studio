# 论文科研图表集成方案

建议先完成“方法图可编辑保存并插入论文”，再增加实验数据图。当前科研图表入口展示规划，尚未开放独立图表工作台。

## 当前基础与关键缺口

前端已有 `figure-book/BoardPage.tsx`、`BoardCanvas.tsx`、`figureDraw.ts`，安装了 Excalidraw、Mermaid 转换器、React Flow 和 Recharts。
后端已有项目级图源、图片上传与资源管理接口。现有功能围绕专利附图组织，不能直接把它当成论文图表系统。

现有 `.mmd` 是保存的真源，画布拖拽调整只进入导出的 PNG，重新打开会重新布局。这是首要缺口：论文图表必须保存画布场景、资源与版本，不能只保存 Mermaid 或导出图片。
当前 Word 工作台也没有把项目图表插入当前光标的专用通道；LaTeX 文件接口仅支持修改已有文本文件，尚不能上传新图片或创建文件。两条链路都需补齐。

## 实现顺序

1. 方法图：复用 Excalidraw 组件。保存 `.excalidraw` 场景及所引用图片；Mermaid 作为可选初始输入。用户修改画布后，场景成为当前编辑真源，重新应用 Mermaid 必须提示会替换布局。默认使用直线、统一字体与出版用配色。
2. 项目图表库：每幅图有稳定 ID、标题、类型、版本、创建者、尺寸、源文件与导出产物。版本快照把源文件、字体配置、渲染器版本和导出文件 SHA 关联起来。
3. Word 插入：通过 ONLYOFFICE 插件的图片插入接口在当前光标插入高分辨率 PNG，使用文档标准图片对象和独立图题段落；图表 ID、源版本留在平台元数据中，DOCX 离开平台仍能正常显示。插入后保存、下载、重开检验。后续再做自动图号与交叉引用。
4. LaTeX 插入：扩展受权限和路径检查约束的工程资源上传、新建文件 API，把 PDF/PNG 导出到 `figures/`，插入 `figure`、`includegraphics`、`caption`、`label`。先保存资源再修改源码；失败时不留下失效引用。
5. 数据图：CSV + 图表配置为真源。先支持折线、分组柱状、散点、误差条、箱线和热力图。显式选择列、聚合、误差类型及单位；缺失值和分母变化需可追溯。前端用 Plotly 预览，按需加载，避免扩大论文编辑器首包。
6. 出版导出：服务端用受限 JSON 图表配置调用固定 Matplotlib 渲染器，输出 PDF/SVG/PNG；不执行任意用户或 AI 生成的 Python。统一物理尺寸、字体与色板，保存可复现实验图配置。

## 格式选择

| 用途 | 首选产物 | 原因 |
| --- | --- | --- |
| 在线画布继续编辑 | Excalidraw 场景 JSON + 图片资源 | 完整保留节点、连接、布局与资源 |
| 实验图继续编辑 | 原始 CSV + 图表 JSON | 数据与样式可重建 |
| Word 投稿与跨 Office 版本 | 按最终版面宽度生成的 PNG | 先保证兼容性，按 300–600 dpi 控制像素尺寸 |
| LaTeX 方法图、实验图 | PDF | 矢量线条与字体随版面缩放 |
| 外部设计软件后期调整 | SVG | 保留向量元素，预览时移除脚本和外部资源 |

不能把“4 倍画布”直接等同于 300 dpi：例如 85 mm 单栏、300 dpi 需要约 1004 像素宽，600 dpi 约 2008 像素。导出时应由论文中的物理宽度计算。
WebGL 类型图在 SVG/PDF 内也可能包含位图；散点大数据、3D 图应单独提示导出分辨率。

## 资源与权限

图表归属项目并继承其 ACL，采用不可变版本与乐观并发。源文件、预览、导出均受项目访问和下载策略约束。
限制上传大小、像素数、CSV 行数与渲染时长；预览 SVG 不执行脚本、不获取外部 URL。
批处理渲染与 LaTeX 编译分队列，避免图表任务阻塞保存。首次实现以单人编辑加版本冲突提示为界，多人同画布协作另设里程碑。

## 最小验收

- 调整节点位置、文字与连线后关闭重开，布局与资源完整恢复。
- 编辑 CSV 后重绘，图表能从已保存数据与配置稳定复现。
- Word 插入、保存、下载、重开可见且不依赖平台 URL；目标尺寸和清晰度正确。
- LaTeX 新图资源可被引用并成功编译，PDF 缩放后线条清晰。
- 未授权成员不能访问源文件或绕过下载限制；冲突保存不覆盖其他人的版本。

## 核对的官方资料

- [Excalidraw 导出 API（canvas/blob/SVG）](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/utils/export)
- [Excalidraw MIT 许可](https://github.com/excalidraw/excalidraw/blob/master/LICENSE)
- [Plotly 静态图导出与 WebGL 限制](https://plotly.com/javascript/static-image-export/)
- [Matplotlib savefig 的格式、DPI 与字体等参数](https://matplotlib.org/stable/api/_as_gen/matplotlib.pyplot.savefig.html)
- [ONLYOFFICE 字体安装与替换造成的版式差异](https://helpcenter.onlyoffice.com/docs/installation/docs-install-fonts-docker.aspx)

调研日期：2026-10-21。库选择为集成建议，科研图表工作台尚未实现；当前已有画板的限制以仓库源码为依据。
