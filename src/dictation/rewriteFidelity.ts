import { validateFinalText } from "./finalTextValidation.js";

const protectedTokenPattern = new RegExp(
  [
    "[A-Za-z][A-Za-z0-9._+\\-/]*",
    "\\d+(?:[.,]\\d+)*(?:[%％])?",
    "[零〇一二两三四五六七八九十百千万亿兆]+",
    "万元|亿元|人民币|美元|港元|欧元|小时|分钟|秒钟|星期|个月",
    "元|块|年|月|日|号|天|周|秒|个|件|次|倍",
    "绝对不能|千万不要|严禁|禁止|不得|不能|不要|不许|拒绝|并非|从未|绝不|没有|没|未|无|不|别",
    "必须|务必|一定|绝对|强烈|立即|马上|尽快|至少|至多|最多|最少|坚决|只|仅",
  ].join("|"),
  "giu",
);

function codePointCount(value: string): number {
  return [...value].length;
}

function removeAllowedFillers(value: string): string {
  return value.replace(/那个|就是|嗯|呃|额|啊/gu, "");
}

type NormalizedTimes = Readonly<{
  facts: readonly string[];
  remainder: string;
}>;

const contextualTimePattern =
  /(上午|早上|早晨|中午|下午|晚上|夜里|凌晨)?(?:的)?\s*(\d{1,2})\s*(?:点|时)(?:\s*(\d{1,2})\s*分?)?/gu;
const clockTimePattern = /\b([01]?\d|2[0-4]):([0-5]\d)\b/gu;
const structuralDatePattern = /(?<!\d)(\d{1,2})\s*(?:号|日)(?!\d)/gu;
const structuralIgnoredPhrases = Object.freeze([
  "上线的过程当中",
  "我来说一下",
  "我说一下",
  "都要在场",
  "过程当中",
  "参与人员",
  "开始进行",
  "在这之前",
  "要进行",
  "需这有",
  "我们把",
  "进行",
  "我们",
  "一次",
  "的时候",
  "时候",
  "以及",
  "人员",
  "正式",
  "那个",
  "就是",
  "在场",
  "参与",
  "开始",
  "将",
  "到",
  "是",
  "吧",
  "及",
  "一下",
  "呃",
  "额",
  "嗯",
  "啊",
  "把",
  "要",
  "都",
  "的",
]);

function normalizeStructuralPhrases(value: string): string {
  return value
    .replace(/明日/gu, "明天")
    .replace(/这一周|这周/gu, "本周")
    .replace(/在此期间|在这当中吧?/gu, "期间")
    .replace(/([一二三四五六七八九十])\1方/gu, "第$1方");
}

function removeStructuralIgnoredPhrases(value: string): string {
  let result = value;
  for (const phrase of structuralIgnoredPhrases) {
    result = result.replaceAll(phrase, "");
  }
  return result;
}

function contextualHour(period: string | undefined, hour: number): number {
  if (period === "下午" || period === "中午") {
    return hour < 12 ? hour + 12 : hour;
  }
  if (period === "晚上" || period === "夜里") {
    if (hour === 12) return 24;
    return hour < 12 ? hour + 12 : hour;
  }
  if (period === "凌晨" && hour === 12) return 0;
  return hour;
}

function normalizedTimes(value: string): NormalizedTimes {
  const facts: string[] = [];
  let remainder = value.replace(
    contextualTimePattern,
    (_match, period: string | undefined, hourText: string, minuteText?: string) => {
      const hour = contextualHour(period, Number(hourText));
      const minute = minuteText === undefined ? 0 : Number(minuteText);
      if (hour > 24 || minute > 59 || (hour === 24 && minute !== 0)) {
        return _match;
      }
      facts.push(`fact:time:${hour * 60 + minute}`);
      return " ";
    },
  );
  remainder = remainder.replace(
    clockTimePattern,
    (_match, hourText: string, minuteText: string) => {
      const hour = Number(hourText);
      const minute = Number(minuteText);
      if (hour === 24 && minute !== 0) return _match;
      facts.push(`fact:time:${hour * 60 + minute}`);
      return " ";
    },
  );
  return Object.freeze({ facts: Object.freeze(facts.sort()), remainder });
}

function normalizedStructuralFacts(value: string): NormalizedTimes {
  const normalized = normalizedTimes(normalizeStructuralPhrases(value));
  const facts = [...normalized.facts];
  const remainder = normalized.remainder.replace(
    structuralDatePattern,
    (_match, dayText: string) => {
      facts.push(`fact:day:${Number(dayText)}`);
      return " ";
    },
  );
  return Object.freeze({ facts: Object.freeze(facts.sort()), remainder });
}

function protectedTokens(value: string, structural: boolean): string[] {
  const normalized = structural
    ? normalizedStructuralFacts(value)
    : normalizedTimes(value);
  const remainder = structural
    ? removeStructuralIgnoredPhrases(normalized.remainder)
    : normalized.remainder;
  const tokens = [...removeAllowedFillers(remainder).matchAll(protectedTokenPattern)].map(
    (match) => `fact:${match[0]!.toLocaleLowerCase("zh-CN")}`,
  );
  return [
    ...normalized.facts,
    ...(structural ? [...new Set(tokens)] : tokens),
  ].sort();
}

function semanticHanSkeleton(value: string): string {
  const skeleton = [...value]
    .filter((character) => /\p{Script=Han}/u.test(character))
    .join("");
  return removeAllowedFillers(skeleton)
    .replace(/(我们|你们|他们|她们|我|你|他|她)\1+/gu, "$1");
}

function isHyphenTimeline(value: string): boolean {
  return value
    .split(/\r?\n/u)
    .filter((line) => /^\s*- +\S/u.test(line)).length >= 2;
}

function structuralHanFacts(value: string): string {
  let normalized = normalizedStructuralFacts(value).remainder;
  normalized = removeStructuralIgnoredPhrases(normalized);
  return [...new Set(
    [...normalized].filter((character) => /\p{Script=Han}/u.test(character)),
  )].sort().join("");
}

/**
 * Rejects structurally impure or obviously unfaithful rewrites. The model
 * prompt remains responsible for prose quality; this guard protects exact
 * numbers (Arabic and Chinese), names/identifiers, common Chinese proper
 * nouns, units, negation, and strength markers.
 */
export function validateFaithfulRewrite(
  rawTranscript: string,
  candidate: unknown,
): string {
  const finalText = validateFinalText(candidate);
  const structural = isHyphenTimeline(finalText);
  const rawLength = codePointCount(rawTranscript.trim());
  const finalLength = codePointCount(finalText);
  if (
    rawLength === 0 ||
    finalLength < Math.max(1, Math.floor(rawLength * 0.35)) ||
    finalLength > Math.ceil(rawLength * 1.75)
  ) {
    throw new Error("Rewrite changed transcript length beyond fidelity bounds");
  }
  const sourceTokens = protectedTokens(rawTranscript, structural);
  const resultTokens = protectedTokens(finalText, structural);
  if (
    (structural
      ? structuralHanFacts(rawTranscript) !== structuralHanFacts(finalText)
      : semanticHanSkeleton(rawTranscript) !== semanticHanSkeleton(finalText)) ||
    sourceTokens.length !== resultTokens.length ||
    sourceTokens.some((token, index) => token !== resultTokens[index])
  ) {
    throw new Error("Rewrite changed protected transcript facts");
  }
  return finalText;
}
