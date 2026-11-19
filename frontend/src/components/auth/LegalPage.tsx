import { ArrowLeft } from 'lucide-react'
import { BrandMark } from '@/components/auth/AuthFrame'
import { BRAND_NAME } from '@/lib/brand'

/**
 * 法务页（生产级合规内容）：#/legal/terms 用户协议 · #/legal/privacy 隐私政策 ·
 * #/legal/copyright 版权与免责声明。匿名与登录态均可达，落地页页脚引流到此。
 */

const DOC_DATE = '2026-10-21'
const DOC_VERSION = 'v1.1'

const DOCS: Record<string, { title: string; sections: [string, string[]][] }> = {
  terms: {
    title: '用户协议（服务条款）',
    sections: [
      ['第一条 总则', [
        '本协议由您（下称「用户」）与研稿 · Paper Studio 服务提供方（下称「本平台」）订立。用户注册、登录或以任何方式使用本平台服务，即视为已阅读、理解并同意接受本协议全部条款。',
        '本平台为面向科研团队的论文写作与审阅工作空间，提供 Word 模板编辑、数学公式、LaTeX 工程与编译预览、批注协作和投稿计划管理。',
      ]],
      ['第二条 服务性质与边界', [
        '本平台提供论文写作、排版与协作工具。启用 AI 时，其生成的段落、公式说明或修改建议应由作者核对。',
        '作者与合作者负责核实研究内容、实验数据、引文来源、署名及投稿材料，遵守所在机构和目标期刊或会议的要求。',
        '模板和编译预览用于辅助准备稿件，不构成学术评价、同行评审意见或录用保证。',
      ]],
      ['第三条 账号与使用规范', [
        '用户应妥善保管账号凭据，按获得的项目权限使用服务，不得超出权限读取或导出他人的论文与研究数据。软件使用与修改遵循仓库及相关组件的开源许可证。',
        '团队部署场景下，成员的数据权限、项目归属与交接，由团队管理策略确定。',
      ]],
      ['第四条 知识产权', [
        '用户上传的论文、图表、数据与其他资料归作者或原权利人所有；本平台不因提供存储和编辑工具而主张稿件权利。',
        '平台软件与第三方组件分别遵循各自的许可证和归属声明，详见仓库 LICENSE、NOTICE 与组件说明。',
        '期刊与会议模板保留其来源和许可说明。上传模板或素材前，应确认拥有相应的使用和分享权限。',
      ]],
      ['第五条 免责与责任限制', [
        '服务按「现状」提供。在法律允许范围内，本平台不就服务的无中断、无错误、绝对安全作担保。用户应按研究数据管理要求备份稿件与原始数据。',
        '因不可抗力、第三方服务（网络、云基础设施、开源组件）故障导致的服务异常，本平台免于承担责任但应及时采取补救措施。',
      ]],
      ['第六条 协议变更与争议', [
        '本平台可修订本协议并在页面公示，修订后继续使用视为接受；不同意修订可停止使用并联系导出数据。',
        '本协议适用中华人民共和国法律（不含冲突规范）；争议协商不成的，提交本平台运营主体所在地有管辖权的人民法院处理。',
      ]],
    ],
  },
  privacy: {
    title: '隐私政策',
    sections: [
      ['一、我们处理哪些信息', [
        '账号信息：用户名、显示名、登录凭据（加盐散列存储）、机构归属与角色权限。',
        '业务数据：您创建或上传的论文项目、Word 与 LaTeX 文件、图表、附件、批注、投稿计划及操作日志。',
        '技术日志：登录与操作审计记录、错误诊断信息——用于安全审计与故障排查。',
      ]],
      ['二、数据存储与共享', [
        '私有部署场景：您的数据存储于机构自有服务器，本平台运营方原则上不接触、不复制业务数据；SaaS/托管场景（如有）将在部署协议中单独约定存储位置与期限。',
        'AI 处理：文本经您机构配置的大模型通道处理；如启用外部推理服务，仅发送完成功能所必需的最小内容片段，具体通道配置由部署方决定并在机构内公示。',
        '除法律法规要求或您明确授权外，不向第三方出售、共享您的论文内容。',
      ]],
      ['三、您的权利', [
        '访问与导出：在项目权限允许时下载 Word 的 DOCX 或 LaTeX 编译的 PDF；保存版本和项目文件按部署方提供的功能管理。',
        '更正与删除：可编辑修正业务数据；账号注销与数据删除请联系机构管理员或服务提供方。',
        '审计留痕：重要操作可查询审计记录（管理员可见）。',
      ]],
      ['四、数据安全', [
        '平台使用凭据加盐散列、项目权限与操作审计。HTTPS/TLS、存储备份和服务访问范围由部署方配置，请按单位研究数据政策部署。',
        '如发生可能影响您数据安全的事件，将依法及时告知并处置。',
      ]],
      ['五、政策更新', [
        '本政策可能随法规与产品演进更新并在页面公示；重大变更将以显著方式提示。',
      ]],
    ],
  },
  copyright: {
    title: '版权与免责声明',
    sections: [
      ['版权声明', [
        `© ${new Date().getFullYear()} 研稿 · Paper Studio。保留所有权利。本平台基于开源软件（Apache-2.0，含原作者归属），相关许可与归属见仓库 NOTICE 与 LICENSE。`,
        '平台内嵌的编辑、编译与界面组件按其各自许可证使用；论文模板保留来源与原有许可。',
      ]],
      ['免责声明', [
        '本平台提供写作与排版辅助，不替代研究者判断、研究伦理审查或同行评审。',
        '作者应核对正文、公式、数据、引文和署名，并检查导出稿件是否符合投稿要求。',
        '研究结论和投稿决定由作者与合作者负责。',
      ]],
      ['第三方内容', [
        '模板来源、参考文献和相关资源可能指向第三方站点，其内容与可用性由第三方负责。',
        '引用或使用第三方论文、数据和图表时，应遵循原始来源的许可及署名要求。',
      ]],
    ],
  },
}

export function LegalPage({ page }: { page: string }) {
  const doc = DOCS[page] ?? DOCS.terms
  return (
    <main className="min-h-dvh bg-app">
      <header className="sticky top-0 z-sticky border-b border-border bg-panel/90 backdrop-blur">
        <div className="mx-auto flex h-12 max-w-3xl items-center gap-2.5 px-4">
          <a href="#/" className="flex items-center gap-2">
            <BrandMark size="sm" />
            <span className="text-sm font-semibold text-fg-strong">{BRAND_NAME}</span>
          </a>
          <a href="#/" className="ml-auto inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg transition-colors">
            <ArrowLeft className="size-4" aria-hidden /> 返回
          </a>
        </div>
      </header>
      <article className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="text-2xl font-semibold text-fg-strong">{doc.title}</h1>
        <p className="mt-2 text-xs text-fg-muted">生效日期 {DOC_DATE} · 版本 {DOC_VERSION}</p>
        <nav className="mt-4 flex gap-4 text-xs">
          <a href="#/legal/terms" className={page === 'terms' ? 'font-semibold text-fg-strong' : 'text-fg-muted hover:text-fg'}>用户协议</a>
          <a href="#/legal/privacy" className={page === 'privacy' ? 'font-semibold text-fg-strong' : 'text-fg-muted hover:text-fg'}>隐私政策</a>
          <a href="#/legal/copyright" className={page === 'copyright' ? 'font-semibold text-fg-strong' : 'text-fg-muted hover:text-fg'}>版权与免责声明</a>
        </nav>
        <div className="mt-8 space-y-7">
          {doc.sections.map(([h, paras]) => (
            <section key={h}>
              <h2 className="text-base font-semibold text-fg-strong">{h}</h2>
              {paras.map((p, i) => (
                <p key={i} className="mt-2 text-sm leading-7 text-fg-muted">{p}</p>
              ))}
            </section>
          ))}
        </div>
        <p className="mt-10 border-t border-border pt-4 text-xs text-fg-muted">
          如对本文件有任何疑问，请通过机构管理员或本平台联系渠道反馈。
        </p>
      </article>
    </main>
  )
}
