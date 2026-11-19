/**
 * 品牌 sole source of truth（w21 品牌统一）：
 * 产品名 / 副题 / 描述集中在此，前端展示面一律从本文件引用，防漂移。
 * 注意：旧名「知撰」仅允许残留在专利项目内部业务文案与历史文档中（见 w21 报告残留清单）。
 */

export const BRAND_NAME = '研稿'
export const BRAND_NAME_FULL = '研稿 · Paper Studio'
export const BRAND_NAME_EN = 'Paper Studio'

/** 一句定位（登录页 / 元信息共用） */
export const BRAND_TAGLINE = '面向科研团队的论文写作与审阅工作空间'

/** 元信息描述（index.html / og 同口径；如实反映当前能力） */
export const BRAND_DESCRIPTION =
  '研稿 · Paper Studio 面向科研团队，支持 Word 期刊模板、可编辑数学公式、LaTeX 工程与 PDF 编译预览。统一管理论文项目、投稿计划、协作批注与保存版本，支持私有化部署。'

/** 浏览器标题（无页面级 title 时的缺省） */
export const BRAND_TITLE = `${BRAND_NAME_FULL} — 论文写作与审阅工作空间`

/** 版权行 */
export const brandCopyright = (year: number = new Date().getFullYear()) => `© ${year} ${BRAND_NAME_FULL}`

/** 页面级标题统一拼接：`<页面> · 研稿` */
export const pageTitle = (page: string | null | undefined): string =>
  page ? `${page} · ${BRAND_NAME}` : BRAND_NAME

/** 当前能力清单（登录页/入口页如实展示，不宣传未实现能力） */
export const BRAND_CAPABILITIES: ReadonlyArray<{ title: string; desc: string }> = [
  { title: 'Word 期刊模板', desc: '直接使用完整 DOCX 模板，保留标题、摘要、页眉和分栏，下载后继续编辑。' },
  { title: 'LaTeX 工程与预览', desc: '编辑原生工程，保存后编译 PDF，支持主文件、编译引擎与诊断定位。' },
  { title: '可编辑数学公式', desc: 'Word 中使用 LaTeX 输入公式，支持再次编辑、居中编号和 DOCX 导出。' },
  { title: '批注与协作', desc: '按项目分配写作与审阅权限，在文档中批注、回复和处理修改意见。' },
  { title: '项目与投稿计划', desc: '按 Word / LaTeX 管理论文，记录投稿期刊、会议和截止日期。' },
  { title: '模板库与私有部署', desc: '管理员维护团队模板，论文、保存版本与协作记录留在部署方的数据空间。' },
]

/** 四步上手流程（登录页品牌区） */
export const BRAND_FLOW: ReadonlyArray<string> = [
  '选择期刊模板，创建或导入论文',
  'Word 直接写作，LaTeX 编译预览',
  '邀请团队协作，处理批注与修订',
  '保存版本，导出稿件准备投稿',
]
