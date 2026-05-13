# Conference MVP

学术会议议题与演讲候选人推荐系统。输入会议大主题，自动生成分论坛议题，并为每个议题推荐合适的演讲嘉宾候选人。

## 功能

- **议题生成**：LLM 根据会议主题生成 N 组 × 3 个候选议题，用户可从中选择
- **候选人推荐**（双路径）：
  - **国际学者**：LLM 提名 → OpenAlex 学术数据库检索验证 → 按引用/H-index 等指标评分
  - **国内学者**：LLM 提名 → 学者主页信息检索（OpenAlex 查 URL + 页面抓取 + LLM 提取职称/基金/论文）→ 按职称资历/基金级别评分
- **PDF 导出**：一键导出推荐报告

## 快速开始

```bash
cp .env.example .env.local
npm install
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)。

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `OPENALEX_MAILTO` | 建议 | OpenAlex 请求标识，填邮箱可提升稳定性 |
| `OPENAI_API_KEY` | 推荐 | LLM API Key（支持 OpenAI / DeepSeek 等兼容接口） |
| `OPENAI_BASE_URL` | 否 | 默认为 `https://api.deepseek.com`，可换其他 endpoint |
| `TOPIC_LLM_MODEL` | 否 | 议题生成模型，默认 `deepseek-v4-flash` |
| `CANDIDATE_LLM_MODEL` | 否 | 候选人推荐模型，默认同上 |

不配置 `OPENAI_API_KEY` 也能运行，但会退回算法生成链路，质量较低。

## 架构

```
用户输入会议主题
        │
        ▼
  ┌─ 议题生成 ─────────────────────┐
  │  LLM 生成 N 组×3 候选议题      │
  │  用户从每组中选取一个            │
  └──────────────┬─────────────────┘
                 │
                 ▼
  ┌─ 候选人推荐 ────────────────────────────────────────┐
  │                                                    │
  │  scope = "domestic"          scope = "international"│
  │       │                              │              │
  │  LLM 提名候选人               LLM 提名候选人        │
  │  (中文名+英文名+机构)          (中文名+英文名)       │
  │       │                              │              │
  │  学者主页检索                   OpenAlex 搜索       │
  │  (查 URL→抓页面→                (按英文名查)        │
  │   LLM 提取职称/基金/论文)             │              │
  │       │                          OpenAlex 评分      │
  │  职称/基金评分                    (引用/H-index等)   │
  │       │                              │              │
  └───────┴──────────────────────────────┴──────────────┘
                          │
                          ▼
                   展示候选人卡片 + 详情
                        + PDF 导出
```

## 技术栈

- **框架**：Next.js 16 (App Router)
- **样式**：Tailwind CSS
- **数据源**：OpenAlex REST API + LLM (DeepSeek/OpenAI)
- **PDF**：React-PDF

## 项目结构

```
src/
├── app/
│   ├── page.tsx               # 首页：输入会议主题
│   ├── topics/page.tsx        # 议题编辑与候选人设置
│   └── results/page.tsx       # 候选人展示
├── components/
│   ├── TopicItemCard.tsx      # 议题候选组展示
│   ├── CandidateCard.tsx      # 候选人卡片
│   ├── CandidateDetailModal.tsx # 候选人详情弹窗
│   └── CandidateSettingsForm.tsx # 范围/数量/青年教师设置
├── lib/
│   ├── models/types.ts        # 数据类型定义
│   ├── services/
│   │   ├── topicGenerationService.ts    # 议题生成
│   │   ├── candidateRecommendationService.ts # 候选人推荐编排
│   │   ├── candidateScoringService.ts   # 评分算法
│   │   ├── scholarSearchService.ts      # OpenAlex 搜索
│   │   ├── scholarRetrievalService.ts   # 国内学者主页检索
│   │   ├── scholarProfileService.ts     # 学者资料丰富
│   │   └── openaiService.ts             # LLM 调用封装
│   └── pdf/                   # PDF 导出模板
└── context/                   # 全局状态管理
```

## 评分维度

### 国际学者（OpenAlex 数据）

| 维度 | 满分 | 依据 |
|------|------|------|
| 主题贴合度 | 40 | 研究方向匹配 |
| 近期活跃度 | 20 | 近 5 年论文数量 |
| 学术影响力 | 20 | H-index + 引用数 |
| 数据可信度 | 10 | 字段完整度 |
| 青年优先 | 5 | 青年教师加分 |

### 国内学者（主页检索 + LLM 画像）

| 维度 | 满分 | 依据 |
|------|------|------|
| 职称资历 | 20 | 院士→20, 二级教授→15, 教授→10, 副教授→5 |
| 基金项目 | 不限 | 长江/杰青→15, 优青→10, 国重/面上→5 |
| 议题匹配 | 20 | 研究方向与议题关键词匹配 |
| 画像完整度 | 10 | title/institution/grants 等字段完整度 |
| 青年优先 | 5 | 讲师/博士后→5, 副高→2 |

## 部署

```bash
npm run build
npm run start
```

要求 Node.js 20+。
