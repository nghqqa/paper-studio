# -*- coding: utf-8 -*-
"""一键创建「全功能演示论文」：让首次进入平台的用户 3 秒体验核心工作流。

预置内容（全部原创合成，零版权负担，零外部网络依赖）：
- LaTeX 论文主文件 `main.tex`（ctex + xelatex）与真实 DOI 的 `refs.bib`（可供文献真实性核验实测）；
- 2 条 AI 修改提案记录（1 条已采纳且含人工二次改写+数值保护确认，1 条待审阅）——打开「AI 披露声明」立即可预览导出；
- 2 条多轮 Rebuttal 审稿意见（1 条已回复、1 条待处理）——打开「审稿回复」立即可体验拆条与导出 Response Letter；
- 完整投稿元数据（venue / stage / keywords）。
"""
from __future__ import annotations

import hashlib
import os
import time
from datetime import UTC, datetime

from app import atomic, config
from app.domain import paper_proposals as pp
from app.domain import rebuttal as reb

SHOWCASE_TITLE = "全功能演示论文：协同科研写作与合规核验"

_MAIN_TEX = r"""\documentclass[11pt,a4paper]{article}
\usepackage{ctex}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage{hyperref}

\title{面向科研团队的可追溯协同论文写作框架（演示工程）}
\author{研稿示例作者}
\date{2026}

\begin{document}
\maketitle

\begin{abstract}
本演示工程展示了研稿（Paper Studio）的完整科研写作闭环：原生 LaTeX 编辑与实时 PDF 预览、
基于 Crossref/OpenAlex 的参考文献真实性核验、AI 提案-确认安全审阅与一键导出 AI 使用披露声明，
以及多轮审稿意见（Rebuttal）逐条回复。
\end{abstract}

\section{引言}
近年来，大语言模型与深度学习方法在自然语言处理与计算机视觉领域取得显著进展~\cite{vaswani2017attention,he2016deep}。
预训练语言模型进一步推动了科研文献理解与写作辅助工具的发展~\cite{devlin2019bert}。
然而，在真实课题组协作场景下，稿件修改记录碎片化、AI 参与边界不透明以及参考文献幻觉问题仍亟待解决。

\section{核心方法}
我们将论文修订建模为带有显式人工确认门控的状态迁移序列，目标函数可写为：
\begin{equation}
  \mathcal{L}(\theta) = \sum_{i=1}^{N} \ell\bigl(f_\theta(x_i), y_i\bigr) + \lambda \|\theta\|_2^2
\end{equation}
实验结果表明，在基准测试集上本框架将修订回溯准确率提升至 96.4\%，平均审阅耗时下降 42\%。

\section{结论}
本工程已预置真实 DOI 文献、AI 提案台账与审稿回复示例，欢迎依次体验左侧文件树、顶部「文献」「论文助手」「审稿回复」与「投稿检查」。

\bibliographystyle{plain}
\bibliography{refs}
\end{document}
"""

_REFS_BIB = """@inproceedings{vaswani2017attention,
  title     = {Attention Is All You Need},
  author    = {Vaswani, Ashish and Shazeer, Noam and Parmar, Niki and Uszkoreit, Jakob and Jones, Llion and Gomez, Aidan N. and Kaiser, Lukasz and Polosukhin, Illia},
  booktitle = {Advances in Neural Information Processing Systems (NeurIPS)},
  year      = {2017},
  doi       = {10.48550/arXiv.1706.03762}
}

@inproceedings{he2016deep,
  title     = {Deep Residual Learning for Image Recognition},
  author    = {He, Kaiming and Zhang, Xiangyu and Ren, Shaoqing and Sun, Jian},
  booktitle = {Proceedings of the IEEE Conference on Computer Vision and Pattern Recognition (CVPR)},
  pages     = {770--778},
  year      = {2016},
  doi       = {10.1109/CVPR.2016.90}
}

@inproceedings{devlin2019bert,
  title     = {BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding},
  author    = {Devlin, Jacob and Chang, Ming-Wei and Lee, Kenton and Toutanova, Kristina},
  booktitle = {Proceedings of NAACL-HLT},
  pages     = {4171--4186},
  year      = {2019},
  doi       = {10.18653/v1/N19-1423}
}
"""


def create_showcase_project(store, pid: str | None = None):
    """创建并填充一份开箱即用的全功能演示论文项目。"""
    target_pid = (pid or "").strip() or store.unique_pid("showcase-demo")
    project = store.create_latex_demo(target_pid, seed_dir=config.JCIP_SEED_DIR, title=SHOWCASE_TITLE)

    # 1. 写入精简可读的 main.tex 与含真实 DOI 的 refs.bib
    main_path = os.path.join(project.dir, "main.tex")
    refs_path = os.path.join(project.dir, "refs.bib")
    with open(main_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(_MAIN_TEX)
    with open(refs_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(_REFS_BIB)

    store.update_settings(
        project.id,
        {
            "latex": {"main": "main.tex", "engine": "xelatex"},
            "submission": {
                "venue": "ICLR 2027（演示目标）",
                "rank": "CCF-A",
                "stage": "revision",
                "keywords": "协同写作, AI披露, 演示工程",
                "deadline": "2027-01-15",
            },
        },
    )

    # 2. 预置 2 条 AI 修改提案台账（1 条已采纳含人工二次编辑+数值保护，1 条待审阅）
    base_sha = hashlib.sha256(_MAIN_TEX.encode("utf-8")).hexdigest()
    now = time.time()
    p_applied = pp.Proposal(
        proposal_id=pp.new_id(),
        mode="latex",
        action="polish",
        instruction="优化实验结果句的学术表达",
        anchor=pp.Anchor(
            file="main.tex",
            base_sha=base_sha,
            original_text="实验结果表明，在基准测试集上本框架将修订回溯准确率提升至 96.4\\%，平均审阅耗时下降 42\\%。",
        ),
        suggested_text="实验结果表明，在基准测试集上，本框架将修订回溯准确率提升至 96.8\\%，平均审阅耗时降低了 42\\%。",
        rationale="增强句式衔接与正式学术表达；数值变动已触发保护提示。",
        model="demo-assistant",
        created_by="showcase",
        created_at=now - 3600,
        updated_at=now - 3500,
        status="applied",
        protection_flags=["numbers"],
        applied_at=now - 3500,
        applied_text="实验结果表明，在基准测试集上本框架将修订回溯准确率提升至 96.4\\%，平均审阅耗时下降 42\\%。",
        applied_by="showcase",
    )
    p_pending = pp.Proposal(
        proposal_id=pp.new_id(),
        mode="latex",
        action="academic",
        instruction="精炼引言最后一句",
        anchor=pp.Anchor(
            file="main.tex",
            base_sha=base_sha,
            original_text="然而，在真实课题组协作场景下，稿件修改记录碎片化、AI 参与边界不透明以及参考文献幻觉问题仍亟待解决。",
        ),
        suggested_text="然而，在多作者协同撰写场景中，修订溯源缺失、AI 辅助披露不规范及引文幻觉风险仍制约着科研写作的可靠性。",
        rationale="使用更凝练的学术术语概括三项核心研究问题。",
        model="demo-assistant",
        created_by="showcase",
        created_at=now - 1800,
        updated_at=now - 1800,
        status="pending",
    )
    pp.append(project.dir, project.id, p_applied, by="showcase")
    pp.append(project.dir, project.id, p_pending, by="showcase")

    # 3. 预置 2 条 Rebuttal 审稿意见（1 条已回复、1 条待处理）
    iso_now = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    reb_state = {
        "schema_version": 1,
        "round": 1,
        "source": {"kind": "text", "filename": "demo-reviews.txt", "imported_at": iso_now},
        "items": [
            {
                "id": "R1-1",
                "reviewer": "Reviewer #1",
                "category": "major",
                "text": "请明确披露稿件修订过程中 AI 辅助工具的使用范围与人工复核机制。",
                "status": "addressed",
                "location": {"file": "main.tex", "section": "核心方法", "line": 31},
                "response": "感谢审稿人的宝贵建议。我们已使用 Paper Studio 的提案-确认台账导出了完整的 AI Usage Disclosure 声明，明确列出辅助润色范围及数值保护人工复核记录。",
                "edits_summary": "已在论文附录补充 AI Usage Disclosure 声明，并在正文中核验全部实验数值。",
                "ai_draft": None,
                "updated_at": iso_now,
                "round": 1,
                "comment_ids": [],
                "snapshot": None,
            },
            {
                "id": "R2-1",
                "reviewer": "Reviewer #2",
                "category": "minor",
                "text": "请核对参考文献列表中的 DOI 与会议年份是否准确无误。",
                "status": "todo",
                "location": {"file": "refs.bib", "section": "参考文献", "line": 1},
                "response": "",
                "edits_summary": "",
                "ai_draft": None,
                "updated_at": iso_now,
                "round": 1,
                "comment_ids": [],
                "snapshot": None,
            },
        ],
    }
    reb_path = os.path.join(project.dir, reb.FILE)
    os.makedirs(os.path.dirname(reb_path), exist_ok=True)
    atomic.write_json(reb_path, reb_state)

    return store.get(project.id)
