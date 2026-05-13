import { requestOpenAiStructuredOutput } from "@/lib/services/openaiService";

export interface RetrievedProfile {
  profileUrl: string;
  title?: string;
  grants?: string[];
  publications?: string[];
  scrapedAt: string;
}

const OPENALEX_BASE_URL = "https://api.openalex.org";
const cache = new Map<string, RetrievedProfile>();

async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = 10000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      cache: "no-store",
    });
  } finally {
    clearTimeout(timer);
  }
}

function extractTextFromHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function searchOpenAlexForHomepage(englishName: string): Promise<string | null> {
  const mailto = process.env.OPENALEX_MAILTO ? `&mailto=${encodeURIComponent(process.env.OPENALEX_MAILTO)}` : "";
  const encoded = encodeURIComponent(englishName);
  const url = `${OPENALEX_BASE_URL}/authors?filter=display_name.search:${encoded},last_known_institutions.country_code:CN&per-page=5&sort=works_count:desc${mailto}`;

  try {
    const response = await fetchWithTimeout(url, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      results?: Array<{ id?: string; display_name?: string; homepage_url?: string }>;
    };
    const author = (payload.results || []).find((a) => a.homepage_url);
    return author?.homepage_url || null;
  } catch {
    return null;
  }
}

async function fetchPageText(url: string): Promise<string | null> {
  try {
    const response = await fetchWithTimeout(url);
    if (!response.ok) return null;
    const html = await response.text();
    const text = extractTextFromHtml(html).slice(0, 10000);
    return text.length >= 50 ? text : null;
  } catch {
    return null;
  }
}

async function extractScholarInfo(
  pageText: string,
  name: string,
  institution?: string,
): Promise<{ title?: string; grants?: string[]; publications?: string[] } | null> {
  const prompt = `你是一名学术信息提取助手。请从以下学者个人主页文本中提取信息。

学者姓名：${name}
${institution ? `所在单位：${institution}` : ""}

要求：
1. 只提取页面中明确出现的信息，不要编造
2. title：提取职称/头衔（如：院士、教授、研究员、副教授、讲师、博士后等）
3. grants：提取科研基金/项目名称（如：国家自然科学基金重点项目、国家重点研发计划等）
4. publications：提取代表性论文标题

页面文本：
${pageText}`;

  const result = await requestOpenAiStructuredOutput<{
    title?: string;
    grants?: string[];
    publications?: string[];
  }>({
    model: process.env.CANDIDATE_LLM_MODEL || process.env.TOPIC_LLM_MODEL || "gpt-4.1-mini",
    schemaName: "scholar_profile_extraction",
    schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        grants: { type: "array", items: { type: "string" } },
        publications: { type: "array", items: { type: "string" } },
      },
      required: [],
      additionalProperties: false,
    },
    prompt,
  });

  if (!result) return null;
  if (!result.title && (!result.grants || result.grants.length === 0) && (!result.publications || result.publications.length === 0)) {
    return null;
  }
  return {
    title: result.title || undefined,
    grants: result.grants?.filter(Boolean) || undefined,
    publications: result.publications?.filter(Boolean) || undefined,
  };
}

export async function retrieveDomesticScholarProfile(
  name: string,
  englishName: string,
  institution?: string,
): Promise<RetrievedProfile | null> {
  const cacheKey = `${englishName}::${institution || ""}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const homepageUrl = await searchOpenAlexForHomepage(englishName);
  if (!homepageUrl) return null;

  const pageText = await fetchPageText(homepageUrl);
  if (!pageText) return null;

  const extracted = await extractScholarInfo(pageText, name, institution);
  if (!extracted) return null;

  const profile: RetrievedProfile = {
    profileUrl: homepageUrl,
    title: extracted.title,
    grants: extracted.grants,
    publications: extracted.publications,
    scrapedAt: new Date().toISOString(),
  };

  cache.set(cacheKey, profile);
  return profile;
}
