import type {
  Candidate,
  CandidateSource,
  DataCompleteness,
  DomesticScoreBreakdown,
  RecommendationResult,
  Scope,
  ScholarRawData,
  Topic,
} from "@/lib/models/types";
import { validateCandidateLinks } from "@/lib/services/linkValidationService";
import {
  hasOpenAiApiKey,
  requestOpenAiStructuredOutput,
} from "@/lib/services/openaiService";
import {
  buildTopicKeywords,
  computeCandidateScore,
  computeDomesticCandidateScore,
  type DomesticInput,
  isYoungScholar,
} from "@/lib/services/candidateScoringService";
import { enrichScholarProfile } from "@/lib/services/scholarProfileService";
import { searchScholarsForSuggestedCandidate } from "@/lib/services/scholarSearchService";
import {
  retrieveDomesticScholarProfile,
  type RetrievedProfile,
} from "@/lib/services/scholarRetrievalService";
import { buildId } from "@/lib/utils/common";

interface RecommendOptions {
  conferenceTheme: string;
  topics: Topic[];
  candidateCountPerTopic: number;
  scope: Scope;
  preferYoungScholar: boolean;
}

interface CandidateSuggestion {
  name: string;
  englishName: string;
  institution?: string;
  title?: string;
  grants?: string[];
  researchAreas?: string;
  rationale?: string;
  homepageUrl?: string;
  publications?: string[];
  sourceTags?: CandidateSource[];
}

interface TopicCandidatesSuggestion {
  topicId: string;
  candidates: CandidateSuggestion[];
}

interface AllTopicsCandidatesPayload {
  suggestions: TopicCandidatesSuggestion[];
}

function normalizeRegion(countryCode?: string): string | undefined {
  if (!countryCode) return undefined;
  if (countryCode === "CN") return "中国";
  return countryCode;
}

function collectMissingFields(candidate: Candidate): string[] {
  const missing: string[] = [];
  if (!candidate.institution) missing.push("单位");
  if (!candidate.region) missing.push("国籍/地区");
  if (!candidate.researchAreas) missing.push("研究方向");
  if (!candidate.homepageUrl) missing.push("学者主页链接");
  if (!candidate.databaseUrl) missing.push("学术数据库链接");
  return missing;
}

function classifyCompleteness(missingCount: number): DataCompleteness {
  if (missingCount <= 1) return "high";
  if (missingCount <= 3) return "medium";
  return "low";
}

function buildReason(
  scholar: ScholarRawData,
  matchedKeywords: string[],
  topicTitle: string,
  preferYoungScholar: boolean,
): string {
  const parts: string[] = [];
  if (matchedKeywords.length > 0) {
    parts.push(`研究方向与议题"${topicTitle}"在${matchedKeywords.join("、")}等关键词上具有直接匹配`);
  }
  if (scholar.recentWorkTitles?.length) {
    parts.push("近五年公开论文主题显示其在该方向持续活跃");
  }
  if (typeof scholar.hIndex === "number" && typeof scholar.citedByCount === "number") {
    parts.push(`公开数据中 H-index ${scholar.hIndex}、被引 ${scholar.citedByCount} 次`);
  }
  if (preferYoungScholar && isYoungScholar(scholar)) {
    parts.push("符合青年教师优先条件");
  }
  if (parts.length === 0) {
    parts.push("已检索到与议题相关的公开学术记录，但可用于解释的字段有限");
  }
  return `${parts.join("；")}。`;
}

function buildResearchAreaText(scholar: ScholarRawData): string | undefined {
  if (scholar.topicNames && scholar.topicNames.length > 0) {
    return scholar.topicNames.slice(0, 5).join("、");
  }
  if (scholar.concepts && scholar.concepts.length > 0) {
    return scholar.concepts.slice(0, 5).join("、");
  }
  return undefined;
}

function buildAchievements(scholar: ScholarRawData): string[] {
  const lines: string[] = [];
  if (typeof scholar.worksCount === "number") {
    lines.push(`公开论文数量（OpenAlex）：${scholar.worksCount}`);
  }
  if (typeof scholar.citedByCount === "number") {
    lines.push(`公开被引次数（OpenAlex）：${scholar.citedByCount}`);
  }
  if (typeof scholar.hIndex === "number") {
    lines.push(`H-index（OpenAlex）：${scholar.hIndex}`);
  }
  if (scholar.recentWorkTitles?.length) {
    lines.push(`近期论文示例：${scholar.recentWorkTitles.slice(0, 2).join("；")}`);
  }
  return lines;
}

function toCandidate(
  scholar: ScholarRawData,
  scoreResult: ReturnType<typeof computeCandidateScore>,
  matchedKeywords: string[],
  reason: string,
): Candidate {
  const candidate: Candidate = {
    id: buildId("cand"),
    externalId: scholar.id,
    name: scholar.originalName ?? scholar.displayName,
    institution: scholar.institution,
    region: normalizeRegion(scholar.countryCode),
    researchAreas: buildResearchAreaText(scholar),
    score: scoreResult.score,
    reason,
    homepageUrl: scholar.homepageUrl,
    databaseUrl: scholar.databaseUrl,
    detailSummary: scholar.recentWorkTitles?.length
      ? `近五年代表论文主题：${scholar.recentWorkTitles.slice(0, 3).join("；")}`
      : "暂未检索到足够的近期论文摘要信息。",
    achievements: buildAchievements(scholar),
    isYoungScholar: isYoungScholar(scholar),
    matchedKeywords,
    scoreBreakdown: scoreResult.scoreBreakdown,
    evidenceSummary: scoreResult.evidenceSummary,
    sourceTags: [scholar.source],
    dataCompleteness: "low",
    missingFields: [],
  };

  const missingFields = collectMissingFields(candidate);
  candidate.missingFields = missingFields;
  candidate.dataCompleteness = classifyCompleteness(missingFields.length);
  return candidate;
}

function identityKey(candidate: Candidate): string {
  return `${candidate.name.toLowerCase()}::${candidate.institution || ""}`;
}

function mergeSourceTags(...sourceLists: CandidateSource[][]): CandidateSource[] {
  return Array.from(new Set(sourceLists.flat()));
}

function hasCandidateEvidence(candidate: Candidate): boolean {
  return Boolean(
    candidate.databaseUrl &&
      ((candidate.matchedKeywords?.length || 0) > 0 ||
        candidate.researchAreas ||
        candidate.detailSummary !== "暂未检索到足够的近期论文摘要信息。" ||
        (candidate.achievements?.length || 0) > 0),
  );
}

async function suggestCandidatesForAllTopics(
  conferenceTheme: string,
  topics: Topic[],
  candidateCountPerTopic: number,
): Promise<AllTopicsCandidatesPayload | null> {
  if (!hasOpenAiApiKey()) return null;

  const topicsList = topics
    .map(
      (topic) =>
        `[${topic.id}] ${topic.title}${topic.description ? ` - ${topic.description}` : ""}${topic.keywords?.length ? `\n  关键词：${topic.keywords.join("、")}` : ""}`,
    )
    .join("\n\n");

  const suggestionCount = candidateCountPerTopic + 3;

  const prompt = `你是一名学术会议组委会顾问。请为以下每个议题分别推荐合适的演讲嘉宾候选人。

要求：
1. 每个议题推荐 ${suggestionCount} 位候选人
2. 候选人必须是真实存在、在各自领域有公开学术记录的学者
3. 同一候选人不得被推荐给多个议题
4. 同时提供候选人的中文姓名（name）和英文姓名（englishName），英文姓名用于学术数据库搜索（如 "San Zhang" 格式）
5. 提供候选人的所在机构（可选）、推荐理由（可选）
6. 优先选择与议题方向直接相关的学者
7. 不要编造人物信息

会议总主题：${conferenceTheme}

议题列表：
${topicsList}`;

  const payload = await requestOpenAiStructuredOutput<AllTopicsCandidatesPayload>({
    model: process.env.CANDIDATE_LLM_MODEL || process.env.TOPIC_LLM_MODEL || "gpt-4.1-mini",
    schemaName: "all_topics_candidate_suggestions",
    schema: {
      type: "object",
      properties: {
        suggestions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              topicId: { type: "string" },
              candidates: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    englishName: { type: "string" },
                    institution: { type: "string" },
                    rationale: { type: "string" },
                  },
                  required: ["name", "englishName"],
                  additionalProperties: false,
                },
              },
            },
            required: ["topicId", "candidates"],
            additionalProperties: false,
          },
        },
      },
      required: ["suggestions"],
      additionalProperties: false,
    },
    prompt,
  });

  return payload;
}

async function scholarsToCandidates(
  scholars: ScholarRawData[],
  topic: Topic,
  topicKeywords: string[],
  preferYoungScholar: boolean,
): Promise<Candidate[]> {
  const enriched = await Promise.all(scholars.map((scholar) => enrichScholarProfile(scholar)));

  return Promise.all(
    enriched.map(async (scholar) => {
      const scoreResult = computeCandidateScore(
        scholar,
        topicKeywords,
        preferYoungScholar,
      );
      const reason = buildReason(
        scholar,
        scoreResult.matchedKeywords,
        topic.title,
        preferYoungScholar,
      );
      const candidate = toCandidate(
        scholar,
        scoreResult,
        scoreResult.matchedKeywords,
        reason,
      );
      return validateCandidateLinks(candidate);
    }),
  );
}

function finalizeCandidate(candidate: Candidate): Candidate {
  const missingFields = collectMissingFields(candidate);
  return {
    ...candidate,
    sourceTags: mergeSourceTags(candidate.sourceTags),
    missingFields,
    dataCompleteness: classifyCompleteness(missingFields.length),
  };
}

async function suggestDomesticCandidatesForAllTopics(
  conferenceTheme: string,
  topics: Topic[],
  candidateCountPerTopic: number,
): Promise<AllTopicsCandidatesPayload | null> {
  if (!hasOpenAiApiKey()) return null;

  const topicsList = topics
    .map(
      (topic) =>
        `[${topic.id}] ${topic.title}${topic.description ? ` - ${topic.description}` : ""}${topic.keywords?.length ? `\n  关键词：${topic.keywords.join("、")}` : ""}`,
    )
    .join("\n\n");

  const suggestionCount = candidateCountPerTopic + 3;

  const prompt = `你是一名学术会议组委会顾问。请为以下每个议题分别推荐合适的国内演讲嘉宾候选人。

要求：
1. 每个议题推荐 ${suggestionCount} 位候选人
2. 候选人必须是真实存在、在各自领域有公开学术记录的国内学者
3. 同一候选人不得被推荐给多个议题
4. 提供候选人的中文姓名（name，必填）和英文姓名（englishName，必填）
5. 提供候选人的职称/头衔（title，如：院士、教授、研究员、副教授等，可选）
6. 提供候选人的主要科研基金项目（grants，如：国家自然科学基金重点项目、国家重点研发计划等，最多3项，可选）
7. 提供候选人的主要研究方向（researchAreas，与议题相关的方向，可选）
8. 提供候选人的所在机构（institution，可选）和推荐理由（rationale，可选）
9. 优先选择与议题方向直接相关的学者
10. 不要编造人物信息

会议总主题：${conferenceTheme}

议题列表：
${topicsList}`;

  const payload = await requestOpenAiStructuredOutput<AllTopicsCandidatesPayload>({
    model: process.env.CANDIDATE_LLM_MODEL || process.env.TOPIC_LLM_MODEL || "gpt-4.1-mini",
    schemaName: "all_topics_candidate_suggestions",
    schema: {
      type: "object",
      properties: {
        suggestions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              topicId: { type: "string" },
              candidates: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    englishName: { type: "string" },
                    institution: { type: "string" },
                    title: { type: "string" },
                    grants: { type: "array", items: { type: "string" } },
                    researchAreas: { type: "string" },
                    rationale: { type: "string" },
                  },
                  required: ["name", "englishName"],
                  additionalProperties: false,
                },
              },
            },
            required: ["topicId", "candidates"],
            additionalProperties: false,
          },
        },
      },
      required: ["suggestions"],
      additionalProperties: false,
    },
    prompt,
  });

  return payload;
}

function domesticSuggestionToCandidate(
  suggestion: CandidateSuggestion,
  topic: Topic,
  topicKeywords: string[],
  preferYoungScholar: boolean,
): Candidate {
  const domesticInput: DomesticInput = {
    name: suggestion.name,
    title: suggestion.title,
    grants: suggestion.grants,
    researchAreas: suggestion.researchAreas,
    institution: suggestion.institution,
    rationale: suggestion.rationale,
  };

  const scoreResult = computeDomesticCandidateScore(
    domesticInput,
    topicKeywords,
    preferYoungScholar,
  );

  const candidate: Candidate = {
    id: buildId("cand"),
    name: suggestion.name,
    institution: suggestion.institution,
    region: "中国",
    researchAreas: suggestion.researchAreas,
    title: suggestion.title,
    grants: suggestion.grants,
    homepageUrl: suggestion.homepageUrl,
    score: scoreResult.score,
    reason: suggestion.rationale || `研究方向与议题"${topic.title}"相关`,
    detailSummary: suggestion.homepageUrl
      ? `已通过学者主页验证：${suggestion.homepageUrl}`
      : suggestion.rationale
        ? `LLM 学术画像：${suggestion.rationale}`
        : "LLM 已根据公开学术信息生成候选人画像。",
    achievements: buildDomesticAchievements(suggestion),
    matchedKeywords: scoreResult.matchedKeywords,
    domesticScoreBreakdown: scoreResult.scoreBreakdown,
    evidenceSummary: scoreResult.evidenceSummary,
    sourceTags: suggestion.sourceTags ?? ["llm_profile"],
    selectionPath: "llm_suggested",
    dataCompleteness: classifyDomesticCompleteness(suggestion),
    missingFields: collectDomesticMissingFields(suggestion),
  };

  return candidate;
}

function buildDomesticAchievements(suggestion: CandidateSuggestion): string[] {
  const lines: string[] = [];
  if (suggestion.title) lines.push(`职称/头衔：${suggestion.title}`);
  if (suggestion.grants?.length) {
    lines.push(`主要基金项目：${suggestion.grants.join("；")}`);
  }
  if (suggestion.publications?.length) {
    lines.push(`代表性论文：${suggestion.publications.slice(0, 3).join("；")}`);
  }
  if (suggestion.rationale) lines.push(`学术贡献：${suggestion.rationale}`);
  return lines;
}

function classifyDomesticCompleteness(suggestion: CandidateSuggestion): DataCompleteness {
  const provided = [
    suggestion.name,
    suggestion.institution,
    suggestion.title,
    suggestion.researchAreas,
    suggestion.grants && suggestion.grants.length > 0 ? true : null,
    suggestion.rationale,
  ].filter(Boolean).length;
  if (provided >= 5) return "high";
  if (provided >= 3) return "medium";
  return "low";
}

function collectDomesticMissingFields(suggestion: CandidateSuggestion): string[] {
  const missing: string[] = [];
  if (!suggestion.institution) missing.push("单位");
  if (!suggestion.title) missing.push("职称/头衔");
  if (!suggestion.researchAreas) missing.push("研究方向");
  if (!suggestion.grants?.length) missing.push("基金项目信息");
  return missing;
}

function mergeRetrievedProfile(
  suggestion: CandidateSuggestion,
  profile: RetrievedProfile,
): CandidateSuggestion {
  return {
    ...suggestion,
    title: profile.title || suggestion.title,
    grants: profile.grants && profile.grants.length > 0
      ? Array.from(new Set([...(suggestion.grants || []), ...profile.grants]))
      : suggestion.grants,
    publications: profile.publications,
    homepageUrl: profile.profileUrl,
    rationale: suggestion.rationale
      ? `${suggestion.rationale}（已通过学者主页 ${profile.profileUrl} 验证）`
      : `已通过学者主页验证：${profile.profileUrl}`,
    sourceTags: [...(suggestion.sourceTags || ["llm_profile"]), "homepage"],
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const executing = new Set<Promise<void>>();
  for (const [index, item] of items.entries()) {
    const p = (async () => { results[index] = await fn(item); })().finally(
      () => executing.delete(p),
    );
    executing.add(p);
    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
  return results;
}

async function recommendDomesticCandidates(
  options: RecommendOptions,
): Promise<RecommendationResult> {
  const usedCandidates = new Set<string>();
  const candidatesByTopic: Record<string, Candidate[]> = {};
  const warnings: string[] = [];
  let usedHomepageRetrieval = false;

  const allSuggestions = await suggestDomesticCandidatesForAllTopics(
    options.conferenceTheme,
    options.topics,
    options.candidateCountPerTopic,
  );

  if (!allSuggestions?.suggestions?.length) {
    warnings.push(
      hasOpenAiApiKey()
        ? "LLM 未能生成国内候选人建议，请检查 API 配置或稍后重试。"
        : "未配置 LLM API 密钥，无法生成候选人建议。请设置 OPENAI_API_KEY。",
    );
    return {
      conferenceTheme: options.conferenceTheme,
      generatedAt: new Date().toISOString(),
      topics: options.topics,
      candidatesByTopic: Object.fromEntries(options.topics.map((t) => [t.id, []])),
      scope: options.scope,
      preferYoungScholar: options.preferYoungScholar,
      warnings,
      sourceSummary: {
        usedMockData: false,
        sources: [],
        note: "LLM 未返回国内候选人建议，无法完成推荐。",
      },
    };
  }

  const suggestionByTopicId = new Map(
    allSuggestions.suggestions.map((s) => [s.topicId, s.candidates]),
  );

  for (const topic of options.topics) {
    const topicKeywords = buildTopicKeywords(topic, options.conferenceTheme);
    const suggestions = suggestionByTopicId.get(topic.id) || [];
    const candidates: Candidate[] = [];

    const enrichedSuggestions = await mapWithConcurrency(
      suggestions,
      async (suggestion) => {
        try {
          const profile = await retrieveDomesticScholarProfile(
            suggestion.name,
            suggestion.englishName,
            suggestion.institution,
          );
          if (profile) {
            usedHomepageRetrieval = true;
            return mergeRetrievedProfile(suggestion, profile);
          }
        } catch {
          // retrieval failed, silently fall back to LLM data
        }
        return suggestion;
      },
      3,
    );

    for (const enrichedSuggestion of enrichedSuggestions) {
      try {
        const candidate = domesticSuggestionToCandidate(
          enrichedSuggestion,
          topic,
          topicKeywords,
          options.preferYoungScholar,
        );

        const key = identityKey(candidate);
        if (usedCandidates.has(key)) continue;

        candidates.push(candidate);
      } catch (error) {
        warnings.push(
          `议题"${topic.title}"的候选人"${enrichedSuggestion.name}"处理失败：${error instanceof Error ? error.message : "未知错误"}`,
        );
      }
    }

    const sorted = candidates.sort((a, b) => b.score - a.score);
    const selected: Candidate[] = [];
    for (const candidate of sorted) {
      if (selected.length >= options.candidateCountPerTopic) break;
      selected.push(candidate);
      usedCandidates.add(identityKey(candidate));
    }

    if (selected.length < options.candidateCountPerTopic) {
      warnings.push(
        `议题"${topic.title}"的候选人不足（LLM 建议 ${suggestions.length} 人，最终入选 ${selected.length} 人，目标 ${options.candidateCountPerTopic} 人）。`,
      );
    }

    candidatesByTopic[topic.id] = selected;
  }

  const dedupedWarnings = Array.from(new Set(warnings));
  const sources: CandidateSource[] = usedHomepageRetrieval
    ? ["llm_profile", "homepage"]
    : ["llm_profile"];
  return {
    conferenceTheme: options.conferenceTheme,
    generatedAt: new Date().toISOString(),
    topics: options.topics,
    candidatesByTopic,
    scope: options.scope,
    preferYoungScholar: options.preferYoungScholar,
    warnings: dedupedWarnings,
    sourceSummary: {
      usedMockData: false,
      sources,
      note: hasOpenAiApiKey()
        ? usedHomepageRetrieval
          ? "当前结果基于 LLM 推荐与学者主页信息检索，部分候选人信息已通过个人主页验证。建议人工复核确认。"
          : "当前结果基于 LLM 生成的国内学者学术画像直接推荐，未经过外部验证。建议人工复核候选人信息的准确性。"
        : "未启用 LLM，无法生成候选人建议。",
    },
  };
}

export async function recommendCandidatesByTopics(
  options: RecommendOptions,
): Promise<RecommendationResult> {
  if (options.scope === "domestic") {
    return recommendDomesticCandidates(options);
  }
  return recommendInternationalCandidates(options);
}

async function recommendInternationalCandidates(
  options: RecommendOptions,
): Promise<RecommendationResult> {
  const usedCandidates = new Set<string>();
  const candidatesByTopic: Record<string, Candidate[]> = {};
  const warnings: string[] = [];
  const sourceCollector = new Set<CandidateSource>();
  let usedMockData = false;

  const allSuggestions = await suggestCandidatesForAllTopics(
    options.conferenceTheme,
    options.topics,
    options.candidateCountPerTopic,
  );

  if (!allSuggestions?.suggestions?.length) {
    warnings.push(
      hasOpenAiApiKey()
        ? "LLM 未能生成候选人建议，请检查 API 配置或稍后重试。"
        : "未配置 LLM API 密钥，无法生成候选人建议。请设置 OPENAI_API_KEY。",
    );
    return {
      conferenceTheme: options.conferenceTheme,
      generatedAt: new Date().toISOString(),
      topics: options.topics,
      candidatesByTopic: Object.fromEntries(options.topics.map((t) => [t.id, []])),
      scope: options.scope,
      preferYoungScholar: options.preferYoungScholar,
      warnings,
      sourceSummary: {
        usedMockData: false,
        sources: [],
        note: "LLM 未返回候选人建议，无法完成推荐。",
      },
    };
  }

  const suggestionByTopicId = new Map(
    allSuggestions.suggestions.map((s) => [s.topicId, s.candidates]),
  );

  for (const topic of options.topics) {
    const topicKeywords = buildTopicKeywords(topic, options.conferenceTheme);
    const suggestions = suggestionByTopicId.get(topic.id) || [];
    const candidates: Candidate[] = [];

    for (const suggestion of suggestions) {
      try {
        const searchResult = await searchScholarsForSuggestedCandidate(
          suggestion,
          topic.title,
          topicKeywords,
          options.scope,
        );
        if (searchResult.usedMockData) usedMockData = true;
        searchResult.sources.forEach((source) => sourceCollector.add(source));

        if (searchResult.scholars.length === 0) {
          warnings.push(
            `议题"${topic.title}"的推荐候选人"${suggestion.name}(${suggestion.englishName})"未在 OpenAlex 中找到匹配记录。`,
          );
          continue;
        }

        const scored = await scholarsToCandidates(
          searchResult.scholars,
          topic,
          topicKeywords,
          options.preferYoungScholar,
        );

        for (const candidate of scored) {
          if (!hasCandidateEvidence(candidate)) continue;
          candidate.selectionPath = "llm_suggested";

          const key = identityKey(candidate);
          if (usedCandidates.has(key)) continue;

          candidates.push(candidate);
        }
      } catch (error) {
        warnings.push(
          `议题"${topic.title}"的候选人"${suggestion.name}"检索失败：${error instanceof Error ? error.message : "未知错误"}`,
        );
      }
    }

    const sorted = candidates.sort((a, b) => b.score - a.score);
    const selected: Candidate[] = [];
    for (const candidate of sorted) {
      if (selected.length >= options.candidateCountPerTopic) break;
      selected.push(candidate);
      usedCandidates.add(identityKey(candidate));
    }

    if (selected.length < options.candidateCountPerTopic) {
      warnings.push(
        `议题"${topic.title}"的候选人不足（LLM 建议 ${suggestions.length} 人，OpenAlex 验证通过 ${candidates.length} 人，最终入选 ${selected.length} 人，目标 ${options.candidateCountPerTopic} 人）。`,
      );
    }

    candidatesByTopic[topic.id] = selected.map(finalizeCandidate);
  }

  const sourceList = Array.from(sourceCollector);
  const dedupedWarnings = Array.from(new Set(warnings));
  return {
    conferenceTheme: options.conferenceTheme,
    generatedAt: new Date().toISOString(),
    topics: options.topics,
    candidatesByTopic,
    scope: options.scope,
    preferYoungScholar: options.preferYoungScholar,
    warnings: dedupedWarnings,
    sourceSummary: {
      usedMockData,
      sources: sourceList.length > 0 ? sourceList : usedMockData ? ["mock"] : [],
      note: usedMockData
        ? "当前结果部分基于示例数据，仅供演示。"
        : hasOpenAiApiKey()
          ? "当前结果基于 LLM 候选人推荐与 OpenAlex 学术数据检索验证。"
          : "未启用 LLM，无法生成候选人建议。",
    },
  };
}
