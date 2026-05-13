import type {
  Candidate,
  CandidateScoreBreakdown,
  ScholarRawData,
  Topic,
} from "../models/types.ts";

export interface CandidateScoreResult {
  score: number;
  scoreBreakdown: CandidateScoreBreakdown;
  matchedKeywords: string[];
  evidenceSummary: string[];
}

export interface LlmCandidateReview {
  externalId: string;
  fitVerdict?: "strong" | "medium" | "weak";
  adjustment: number;
  reason: string;
  detailSummary: string;
  matchedKeywords: string[];
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

const keywordExpansionMap: Array<{ pattern: RegExp; expansion: string[] }> = [
  {
    pattern: /人工智能|AI|机器学习|深度学习/gi,
    expansion: ["artificial intelligence", "machine learning", "deep learning"],
  },
  { pattern: /自然语言处理/gi, expansion: ["natural language processing"] },
  { pattern: /医学|医疗|临床|健康/gi, expansion: ["medical", "clinical", "healthcare"] },
  { pattern: /主题建模/gi, expansion: ["topic modeling"] },
  { pattern: /影像|医学影像/gi, expansion: ["medical imaging", "computer vision"] },
  { pattern: /治理|数字治理/gi, expansion: ["governance", "digital governance"] },
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function phraseMatches(haystack: string, keyword: string): boolean {
  const normalizedHaystack = normalize(haystack);
  const normalizedKeyword = normalize(keyword);
  if (!normalizedKeyword) return false;
  if (normalizedHaystack.includes(normalizedKeyword)) return true;
  const keywordTokens = tokenize(normalizedKeyword);
  if (keywordTokens.length <= 1) return false;
  return keywordTokens.every((token) => normalizedHaystack.includes(token));
}

export function buildTopicKeywords(topic: Topic, theme: string): string[] {
  const baseKeywords = topic.keywords || [];
  const expanded: string[] = [];
  [...baseKeywords, topic.title, topic.description || "", theme].forEach((item) => {
    keywordExpansionMap.forEach(({ pattern, expansion }) => {
      if (pattern.test(item)) {
        expanded.push(...expansion);
      }
    });
  });
  return Array.from(
    new Set([
      ...baseKeywords,
      ...expanded,
      ...tokenize(topic.title),
      ...tokenize(topic.description || ""),
      ...tokenize(theme),
    ].map(normalize).filter(Boolean)),
  );
}

function collectMatchedKeywords(topicKeywords: string[], scholar: ScholarRawData): string[] {
  const evidenceTexts = [
    ...(scholar.topicNames || []),
    ...(scholar.concepts || []),
    ...(scholar.recentWorkTitles || []),
    ...(scholar.recentRelevantWorks || []).flatMap((work) => [
      work.title,
      ...(work.topicNames || []),
    ]),
  ];
  return topicKeywords
    .filter((keyword) => evidenceTexts.some((text) => phraseMatches(text, keyword)))
    .slice(0, 5);
}

function computeTopicFit(topicKeywords: string[], scholar: ScholarRawData): number {
  const matched = collectMatchedKeywords(topicKeywords, scholar);
  const keywordScore = Math.min(18, matched.length * 4);
  const relevantWorkScore = Math.min(14, (scholar.recentRelevantWorks?.length || 0) * 7);
  const titleHitScore = (scholar.recentRelevantWorks || []).some((work) =>
    topicKeywords.some((keyword) => phraseMatches(work.title, keyword)),
  )
    ? 8
    : 0;
  return clamp(keywordScore + relevantWorkScore + titleHitScore, 0, 40);
}

function computeRecency(scholar: ScholarRawData): number {
  const currentYear = new Date().getFullYear();
  const works = scholar.recentRelevantWorks || [];
  const workCountScore = Math.min(12, works.length * 4);
  const freshnessScore = Math.min(
    8,
    works.reduce((total, work) => {
      if (!work.publicationYear) return total;
      const age = currentYear - work.publicationYear;
      if (age <= 1) return total + 3;
      if (age <= 3) return total + 2;
      if (age <= 5) return total + 1;
      return total;
    }, 0),
  );
  return clamp(workCountScore + freshnessScore, 0, 20);
}

function computeImpact(scholar: ScholarRawData): number {
  const citationScore = Math.min(10, Math.log10((scholar.citedByCount || 0) + 1) * 2);
  const hIndexScore = Math.min(7, (scholar.hIndex || 0) / 8);
  const relevantCitationScore = Math.min(
    3,
    Math.log10(
      (scholar.recentRelevantWorks || []).reduce(
        (total, work) => total + (work.citedByCount || 0),
        0,
      ) + 1,
    ),
  );
  return Math.round(clamp(citationScore + hIndexScore + relevantCitationScore, 0, 20));
}

function computeDataConfidence(scholar: ScholarRawData): number {
  let score = 0;
  if (scholar.institution) score += 2;
  if (scholar.countryCode) score += 2;
  if (scholar.databaseUrl) score += 2;
  if (scholar.homepageUrl || scholar.orcid) score += 1;
  if ((scholar.topicNames?.length || 0) > 0 || (scholar.concepts?.length || 0) > 0) score += 1;
  if ((scholar.recentRelevantWorks?.length || 0) > 0) score += 2;
  return clamp(score, 0, 10);
}

function isYoungScholarCandidate(scholar: ScholarRawData): boolean {
  const hIndex = scholar.hIndex ?? 999;
  const works = scholar.worksCount ?? 999;
  return hIndex <= 25 || works <= 100;
}

export function computeCandidateScore(
  scholar: ScholarRawData,
  topicKeywords: string[],
  preferYoungScholar: boolean,
): CandidateScoreResult {
  const matchedKeywords = collectMatchedKeywords(topicKeywords, scholar);
  const scoreBreakdown: CandidateScoreBreakdown = {
    topicFit: computeTopicFit(topicKeywords, scholar),
    recency: computeRecency(scholar),
    impact: computeImpact(scholar),
    dataConfidence: computeDataConfidence(scholar),
    youngBonus: preferYoungScholar && isYoungScholarCandidate(scholar) ? 5 : 0,
    llmAdjustment: 0,
  };
  const score = sumBreakdown(scoreBreakdown);
  const evidenceSummary = buildEvidenceSummary(scholar, matchedKeywords);
  return { score, scoreBreakdown, matchedKeywords, evidenceSummary };
}

function sumBreakdown(breakdown: CandidateScoreBreakdown): number {
  return Math.round(
    breakdown.topicFit +
      breakdown.recency +
      breakdown.impact +
      breakdown.dataConfidence +
      breakdown.youngBonus +
      breakdown.llmAdjustment,
  );
}

function buildEvidenceSummary(scholar: ScholarRawData, matchedKeywords: string[]): string[] {
  const evidence: string[] = [];
  if (matchedKeywords.length > 0) {
    evidence.push(`匹配关键词：${matchedKeywords.join("、")}`);
  }
  (scholar.recentRelevantWorks || []).slice(0, 3).forEach((work) => {
    const year = work.publicationYear ? `${work.publicationYear}，` : "";
    evidence.push(`${year}${work.title}`);
  });
  if (typeof scholar.hIndex === "number" || typeof scholar.citedByCount === "number") {
    evidence.push(
      `影响力指标：H-index ${scholar.hIndex ?? "未知"}，被引 ${scholar.citedByCount ?? "未知"}`,
    );
  }
  return evidence.slice(0, 5);
}

export function applyLlmReviewToCandidate(
  candidate: Candidate,
  review: LlmCandidateReview,
): Candidate {
  const currentBreakdown = candidate.scoreBreakdown || {
    topicFit: 0,
    recency: 0,
    impact: 0,
    dataConfidence: 0,
    youngBonus: 0,
    llmAdjustment: 0,
  };
  const adjustment = clamp(Math.round(review.adjustment || 0), -5, 5);
  const nextBreakdown = {
    ...currentBreakdown,
    llmAdjustment: adjustment,
  };
  return {
    ...candidate,
    score: sumBreakdown(nextBreakdown),
    scoreBreakdown: nextBreakdown,
    reason: review.reason.trim() || candidate.reason,
    detailSummary: review.detailSummary.trim() || candidate.detailSummary,
    matchedKeywords: review.matchedKeywords.map((keyword) => keyword.trim()).filter(Boolean).slice(0, 4),
    llmReviewNote: review.reason.trim() || candidate.llmReviewNote,
  };
}

export function isYoungScholar(scholar: ScholarRawData): boolean {
  return isYoungScholarCandidate(scholar);
}

export interface DomesticInput {
  name: string;
  title?: string;
  grants?: string[];
  researchAreas?: string;
  institution?: string;
  rationale?: string;
}

export interface DomesticScoreResult {
  score: number;
  scoreBreakdown: import("@/lib/models/types").DomesticScoreBreakdown;
  matchedKeywords: string[];
  evidenceSummary: string[];
}

function computeTitleScore(title?: string): number {
  if (!title) return 0;
  if (/院士/.test(title)) return 20;
  if (/二级岗教授|二级教授/.test(title)) return 15;
  if (/(?<!副)教授|(?<!副)研究员/.test(title)) return 10;
  if (/副教授|副研究员/.test(title)) return 5;
  if (/讲师/.test(title)) return 2;
  if (/博士后/.test(title)) return 0;
  return 0;
}

function computeGrantScore(grants?: string[]): number {
  if (!grants || grants.length === 0) return 0;
  return grants.reduce((total, grant) => {
    if (/长江学者|杰出青年|杰青|a类|A类|千人计划|万人计划/.test(grant)) return total + 15;
    if (/优秀青年|优青|b类|B类|青年拔尖|青年长江|青千/.test(grant)) return total + 10;
    if (/国家重点实验室/.test(grant)) return total + 5;
    if (/国家自然科学基金面上|国自然面上|面上项目|青年基金/.test(grant)) return total + 5;
    return total;
  }, 0);
}

function computeDomesticTopicFit(topicKeywords: string[], researchAreas?: string): number {
  if (!researchAreas) return 0;
  const matched = topicKeywords.filter((keyword) => {
    const area = normalize(researchAreas);
    const kw = normalize(keyword);
    if (!kw) return false;
    return area.includes(kw) || kw.split(" ").every((token) => token.length > 1 && area.includes(token));
  });
  return Math.min(20, matched.length * 4);
}

function computeProfileCompleteness(input: DomesticInput): number {
  let score = 0;
  if (input.title) score += 3;
  if (input.institution) score += 2;
  if (input.grants && input.grants.length > 0) score += 2;
  if (input.researchAreas) score += 2;
  if (input.rationale && input.rationale.length > 50) score += 1;
  return score;
}

function computeDomesticYoungBonus(title?: string, preferYoungScholar?: boolean): number {
  if (!preferYoungScholar) return 0;
  if (!title) return 5;
  if (/讲师|博士后|助理/.test(title)) return 5;
  if (/副/.test(title)) return 2;
  return 0;
}

export function computeDomesticCandidateScore(
  input: DomesticInput,
  topicKeywords: string[],
  preferYoungScholar: boolean,
): DomesticScoreResult {
  const titleScore = computeTitleScore(input.title);
  const grantScore = computeGrantScore(input.grants);
  const topicFit = computeDomesticTopicFit(topicKeywords, input.researchAreas);
  const profileCompleteness = computeProfileCompleteness(input);
  const youngBonus = computeDomesticYoungBonus(input.title, preferYoungScholar);

  const scoreBreakdown = {
    titleScore,
    grantScore,
    topicFit,
    profileCompleteness,
    youngBonus,
  };

  const matchedKeywords = topicKeywords.filter((keyword) => {
    if (topicFit > 0 && input.researchAreas) {
      const area = normalize(input.researchAreas);
      const kw = normalize(keyword);
      if (!kw) return false;
      return area.includes(kw) || kw.split(" ").every((token) => token.length > 1 && area.includes(token));
    }
    return false;
  }).slice(0, 5);

  const evidenceSummary = buildDomesticEvidenceSummary(input, matchedKeywords);
  const score = Math.round(titleScore + grantScore + topicFit + profileCompleteness + youngBonus);

  return { score, scoreBreakdown, matchedKeywords, evidenceSummary };
}

function buildDomesticEvidenceSummary(input: DomesticInput, matchedKeywords: string[]): string[] {
  const evidence: string[] = [];
  if (matchedKeywords.length > 0) {
    evidence.push(`研究方向匹配关键词：${matchedKeywords.join("、")}`);
  }
  if (input.title) {
    evidence.push(`学术职称：${input.title}`);
  }
  if (input.grants?.length) {
    evidence.push(`主持/参与基金项目：${input.grants.join("；")}`);
  }
  if (input.rationale) {
    evidence.push(`推荐理由：${input.rationale}`);
  }
  return evidence.slice(0, 5);
}
