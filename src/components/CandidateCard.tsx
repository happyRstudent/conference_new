import type { Candidate } from "@/lib/models/types";

interface Props {
  candidate: Candidate;
  onViewDetail: (candidate: Candidate) => void;
}

const sourceLabels: Record<string, string> = {
  openalex: "OpenAlex",
  semanticscholar: "Semantic Scholar",
  orcid: "ORCID",
  mock: "示例数据",
  llm_profile: "LLM 学术画像",
};

export function CandidateCard({ candidate, onViewDetail }: Props) {
  const completenessLabel =
    candidate.dataCompleteness === "high"
      ? "数据较完整"
      : candidate.dataCompleteness === "medium"
        ? "部分字段缺失"
        : "仅检索到基础公开信息";

  return (
    <article className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-2 flex items-start justify-between gap-2">
        <h4 className="text-base font-semibold text-slate-900">{candidate.name}</h4>
        <span className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-700">
          综合评分 {candidate.score}
        </span>
      </div>
      {candidate.title ? (
        <p className="text-sm text-slate-700">职称：{candidate.title}</p>
      ) : null}
      <p className="text-sm text-slate-700">单位：{candidate.institution || "暂未获取"}</p>
      {candidate.region ? (
        <p className="text-sm text-slate-700">国籍/地区：{candidate.region}</p>
      ) : null}
      <p className="text-sm text-slate-700">研究方向：{candidate.researchAreas || "暂未获取"}</p>
      {candidate.grants && candidate.grants.length > 0 ? (
        <p className="text-sm text-slate-700">基金项目：{candidate.grants.length} 项</p>
      ) : null}
      <p className="mt-1 text-xs text-slate-500">数据完整度：{completenessLabel}</p>
      <p className="mt-1 text-xs text-slate-500">
        数据来源：{candidate.sourceTags.length > 0 ? candidate.sourceTags.map((tag) => sourceLabels[tag] || tag).join(" / ") : "暂未标注"}
      </p>
      <p className="mt-2 text-sm leading-6 text-slate-600">{candidate.reason}</p>
      {candidate.missingFields.length > 0 ? (
        <p className="mt-2 text-xs text-amber-700">
          缺失字段：{candidate.missingFields.join("、")}
        </p>
      ) : null}
      {candidate.duplicateNote ? (
        <p className="mt-2 text-xs text-slate-500">{candidate.duplicateNote}</p>
      ) : null}
      <div className="mt-3 space-y-1 text-xs">
        {candidate.homepageUrl ? (
          <a
            className="block text-blue-700 hover:underline"
            href={candidate.homepageUrl}
            target="_blank"
            rel="noreferrer"
          >
            学者主页链接
          </a>
        ) : (
          <p className="text-slate-500">学者主页链接：暂未获取</p>
        )}
        {candidate.databaseUrl ? (
          <a
            className="block text-blue-700 hover:underline"
            href={candidate.databaseUrl}
            target="_blank"
            rel="noreferrer"
          >
            学术数据库页面链接
          </a>
        ) : (
          <p className="text-slate-500">学术数据库页面链接：暂未获取</p>
        )}
      </div>
      <button
        className="mt-4 rounded border border-slate-300 px-3 py-1 text-sm text-slate-700 hover:bg-slate-50"
        onClick={() => onViewDetail(candidate)}
        type="button"
      >
        查看详情
      </button>
    </article>
  );
}
