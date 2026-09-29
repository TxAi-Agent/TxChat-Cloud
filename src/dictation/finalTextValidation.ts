export const FINAL_TEXT_MAX_CODE_POINTS = 20_000;

const META_PREFIX_MAX_CODE_POINTS = 96;
const MARKDOWN_TAB_STOP_COLUMNS = 4;

const chineseCourtesies = [
  "好的",
  "当然",
  "可以",
  "没问题",
] as const;

const englishCourtesies = [
  "of course",
  "certainly",
  "sure",
  "okay",
  "ok",
] as const;

const chinesePresentations = ["下面是", "以下是", "这是"] as const;
const chineseActions = ["整理", "改写", "润色", "处理"] as const;
const chinesePresentationNouns = [
  "文本",
  "文字",
  "内容",
  "版本",
] as const;

const englishIntroductions = [
  "here is the ",
  "here's the ",
  "below is the ",
  "the following is the ",
] as const;
const englishActions = [
  "revised",
  "rewritten",
  "polished",
  "edited",
  "cleaned",
  "organized",
] as const;
const englishPresentationNouns = [
  "text",
  "version",
  "transcript",
] as const;

const approvedTechnicalDunders = new Set(
  [
    "new init del repr str bytes format",
    "lt le eq ne gt ge hash bool",
    "getattribute getattr setattr delattr dir",
    "get set delete set_name",
    "len length_hint getitem setitem delitem missing",
    "iter reversed contains",
    "add sub mul matmul truediv floordiv mod divmod pow",
    "lshift rshift and xor or",
    "radd rsub rmul rmatmul rtruediv rfloordiv rmod rdivmod rpow",
    "rlshift rrshift rand rxor ror",
    "iadd isub imul imatmul itruediv ifloordiv imod ipow",
    "ilshift irshift iand ixor ior",
    "neg pos abs invert complex int float index round trunc floor ceil",
    "enter exit aenter aexit",
    "await aiter anext call",
    "init_subclass class_getitem mro_entries prepare",
    "instancecheck subclasscheck",
    "getnewargs getstate setstate reduce reduce_ex",
  ].flatMap((group) => group.split(" ")),
);

function isAsciiDigit(character: string | undefined): boolean {
  return (
    character !== undefined &&
    character >= "0" &&
    character <= "9"
  );
}

function isAsciiLetter(character: string | undefined): boolean {
  return (
    character !== undefined &&
    ((character >= "a" && character <= "z") ||
      (character >= "A" && character <= "Z"))
  );
}

function isAsciiWord(character: string | undefined): boolean {
  return (
    isAsciiLetter(character) ||
    isAsciiDigit(character) ||
    character === "_"
  );
}

function isHorizontalWhitespace(
  character: string | undefined,
): boolean {
  return character === " " || character === "\t";
}

function isWhitespace(character: string | undefined): boolean {
  return (
    isHorizontalWhitespace(character) ||
    character === "\n" ||
    character === "\r"
  );
}

function isDisallowedControl(codePoint: number): boolean {
  return (
    (codePoint < 0x20 &&
      codePoint !== 0x09 &&
      codePoint !== 0x0a &&
      codePoint !== 0x0d) ||
    (codePoint >= 0x7f && codePoint <= 0x9f)
  );
}

function validatedProviderText(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Provider returned invalid final text");
  }

  let codePoints = 0;
  for (const character of value) {
    codePoints += 1;
    if (
      codePoints > FINAL_TEXT_MAX_CODE_POINTS ||
      isDisallowedControl(character.codePointAt(0) ?? 0)
    ) {
      throw new Error("Provider returned invalid final text");
    }
  }

  if (value.trim().length === 0) {
    throw new Error("Provider returned invalid final text");
  }
  return value;
}

function lines(value: string): string[] {
  const result: string[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "\n" && value[index] !== "\r") {
      continue;
    }
    result.push(value.slice(start, index));
    if (
      value[index] === "\r" &&
      value[index + 1] === "\n"
    ) {
      index += 1;
    }
    start = index + 1;
  }
  result.push(value.slice(start));
  return result;
}

function contentStart(line: string): number {
  let index = 0;
  while (
    index < line.length &&
    isHorizontalWhitespace(line[index])
  ) {
    index += 1;
  }
  return index;
}

function hasIndentedCodeLine(line: string): boolean {
  let columns = 0;
  let index = 0;
  while (index < line.length) {
    if (line[index] === " ") {
      columns += 1;
    } else if (line[index] === "\t") {
      columns +=
        MARKDOWN_TAB_STOP_COLUMNS -
        (columns % MARKDOWN_TAB_STOP_COLUMNS);
    } else {
      break;
    }
    index += 1;
  }
  return (
    columns >= MARKDOWN_TAB_STOP_COLUMNS &&
    index < line.length
  );
}

function isMarkerOnly(
  value: string,
  marker: "-" | "*" | "_" | "=",
  minimum: number,
): boolean {
  let count = 0;
  for (const character of value.trim()) {
    if (character === marker) {
      count += 1;
    } else if (!isHorizontalWhitespace(character)) {
      return false;
    }
  }
  return count >= minimum;
}

function isTableDelimiterCell(value: string): boolean {
  const cell = value.trim();
  let start = cell.startsWith(":") ? 1 : 0;
  const end = cell.endsWith(":")
    ? cell.length - 1
    : cell.length;
  let hyphens = 0;
  while (start < end && cell[start] === "-") {
    hyphens += 1;
    start += 1;
  }
  return start === end && hyphens >= 3;
}

function isTableDelimiter(value: string): boolean {
  let line = value.trim();
  if (!line.includes("|")) {
    return false;
  }
  if (line.startsWith("|")) {
    line = line.slice(1);
  }
  if (line.endsWith("|")) {
    line = line.slice(0, -1);
  }
  const cells = line.split("|");
  return (
    cells.length >= 2 &&
    cells.every((cell) => isTableDelimiterCell(cell))
  );
}

function isTechnicalComparison(line: string, index: number): boolean {
  const next = line[index + 1];
  if (isAsciiDigit(next)) {
    return true;
  }
  if (next !== "=") {
    return false;
  }
  let operand = index + 2;
  while (isHorizontalWhitespace(line[operand])) {
    operand += 1;
  }
  return isAsciiDigit(line[operand]);
}

function isMarkdownLine(
  line: string,
  previousLine: string | undefined,
): boolean {
  if (hasIndentedCodeLine(line)) {
    return true;
  }
  const start = contentStart(line);
  const first = line[start];

  if (
    first === ">" &&
    !isTechnicalComparison(line, start)
  ) {
    return true;
  }

  if (first === "`" || first === "~") {
    let fenceLength = 0;
    while (line[start + fenceLength] === first) {
      fenceLength += 1;
    }
    if (fenceLength >= 3) {
      return true;
    }
  }

  if (
    (first === "*" || first === "+") &&
    isHorizontalWhitespace(line[start + 1])
  ) {
    return true;
  }
  if (first === "-" && line[start + 1] === "\t") {
    return true;
  }

  if (
    isMarkerOnly(line.slice(start), "-", 3) ||
    isMarkerOnly(line.slice(start), "*", 3) ||
    isMarkerOnly(line.slice(start), "_", 3)
  ) {
    return true;
  }

  let marker = start;
  while (line[marker] === "#") {
    marker += 1;
  }
  if (
    marker > start &&
    marker - start <= 6 &&
    isHorizontalWhitespace(line[marker])
  ) {
    return true;
  }

  marker = start;
  while (
    marker - start < 9 &&
    isAsciiDigit(line[marker])
  ) {
    marker += 1;
  }
  if (
    marker > start &&
    (line[marker] === "." || line[marker] === ")") &&
    isHorizontalWhitespace(line[marker + 1])
  ) {
    return true;
  }

  return (
    isMarkdownReferenceDefinition(line, start) ||
    previousLine !== undefined &&
    previousLine.trim().length > 0 &&
    (isMarkerOnly(line, "=", 1) ||
      isMarkerOnly(line, "-", 1) ||
      (previousLine.includes("|") && isTableDelimiter(line)))
  );
}

function isMarkdownReferenceDefinition(
  line: string,
  start: number,
): boolean {
  if (line[start] !== "[") {
    return false;
  }
  for (let index = start + 1; index < line.length; index += 1) {
    if (line[index] === "]") {
      return index > start + 1 && line[index + 1] === ":";
    }
  }
  return false;
}

function hasMarkdownBlockSyntax(value: string): boolean {
  const textLines = lines(value);
  for (let index = 0; index < textLines.length; index += 1) {
    if (isMarkdownLine(textLines[index] ?? "", textLines[index - 1])) {
      return true;
    }
  }
  return false;
}

function hasPairedToken(value: string, token: string): boolean {
  let opening: number | undefined;
  for (let index = 0; index < value.length; index += 1) {
    if (!value.startsWith(token, index)) {
      continue;
    }
    if (
      opening !== undefined &&
      index > opening + token.length
    ) {
      return true;
    }
    opening = index;
    index += token.length - 1;
  }
  return false;
}

function approvedPythonDunderEnd(
  value: string,
  opening: number,
): number | undefined {
  if (
    value[opening] !== "_" ||
    value[opening + 1] !== "_"
  ) {
    return undefined;
  }
  const nameStart = opening + 2;
  let closing = nameStart;
  while (
    isAsciiWord(value[closing]) &&
    !(
      value[closing] === "_" &&
      value[closing + 1] === "_"
    )
  ) {
    closing += 1;
  }
  if (
    closing === nameStart ||
    value[closing] !== "_" ||
    value[closing + 1] !== "_"
  ) {
    return undefined;
  }
  const name = value.slice(nameStart, closing);
  if (!approvedTechnicalDunders.has(name)) {
    return undefined;
  }
  return closing + 2;
}

function delimiterRunLength(
  value: string,
  start: number,
  delimiter: "*" | "_",
): number {
  let length = 0;
  while (value[start + length] === delimiter) {
    length += 1;
  }
  return length;
}

function isNumericOperator(
  value: string,
  start: number,
  runLength: number,
): boolean {
  return (
    isAsciiDigit(value[start - 1]) &&
    isAsciiDigit(value[start + runLength])
  );
}

function hasMarkdownEmphasis(
  value: string,
  delimiter: "*" | "_",
): boolean {
  let hasOpeningDelimiter = false;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== delimiter) {
      continue;
    }

    if (delimiter === "_") {
      const approvedEnd = approvedPythonDunderEnd(value, index);
      if (approvedEnd !== undefined) {
        index = approvedEnd - 1;
        continue;
      }
    }

    const runLength = delimiterRunLength(
      value,
      index,
      delimiter,
    );
    const intrawordUnderscore =
      delimiter === "_" &&
      isAsciiWord(value[index - 1]) &&
      isAsciiWord(value[index + runLength]);
    if (
      isNumericOperator(value, index, runLength) ||
      intrawordUnderscore
    ) {
      index += runLength - 1;
      continue;
    }

    const canClose =
      value[index - 1] !== undefined &&
      !isWhitespace(value[index - 1]);
    if (hasOpeningDelimiter && canClose) {
      return true;
    }
    const canOpen =
      value[index + runLength] !== undefined &&
      !isWhitespace(value[index + runLength]);
    if (canOpen) {
      hasOpeningDelimiter = true;
    }
    index += runLength - 1;
  }
  return false;
}

function hasMarkdownLink(value: string): boolean {
  let labelStart: number | undefined;
  let destinationStart: number | undefined;
  let referenceStart: number | undefined;
  for (let index = 0; index < value.length; index += 1) {
    if (destinationStart !== undefined) {
      if (
        value[index] === ")" &&
        index > destinationStart
      ) {
        return true;
      }
      continue;
    }
    if (referenceStart !== undefined) {
      if (value[index] === "]") {
        return true;
      }
      continue;
    }
    if (value[index] === "[") {
      labelStart = index;
      continue;
    }
    if (
      value[index] === "]" &&
      labelStart !== undefined &&
      index > labelStart + 1 &&
      value[index + 1] === "("
    ) {
      destinationStart = index + 2;
      index += 1;
      continue;
    }
    if (
      value[index] === "]" &&
      labelStart !== undefined &&
      index > labelStart + 1 &&
      value[index + 1] === "["
    ) {
      referenceStart = index + 2;
      index += 1;
    }
  }
  return false;
}

function hasMarkdownInlineSyntax(value: string): boolean {
  return (
    hasMarkdownEmphasis(value, "*") ||
    hasMarkdownEmphasis(value, "_") ||
    hasPairedToken(value, "~~") ||
    hasPairedToken(value, "`") ||
    hasMarkdownLink(value)
  );
}

function hasHtmlSyntax(value: string): boolean {
  for (let opening = 0; opening < value.length; opening += 1) {
    if (value[opening] !== "<") {
      continue;
    }
    const next = value[opening + 1];
    const tagNameStart = next === "/" ? opening + 2 : opening + 1;
    if (isAsciiLetter(value[tagNameStart])) {
      return true;
    }
    if (
      next === "!" &&
      (value.startsWith("<!--", opening) ||
        isAsciiLetter(value[opening + 2]) ||
        value[opening + 2] === "[")
    ) {
      return true;
    }
    if (
      next === "?" &&
      isAsciiLetter(value[opening + 2])
    ) {
      return true;
    }
  }
  return false;
}

function isMetaSeparator(
  character: string | undefined,
): boolean {
  return (
    isWhitespace(character) ||
    character === "," ||
    character === "，" ||
    character === "!" ||
    character === "！" ||
    character === ":" ||
    character === "：" ||
    character === "." ||
    character === "。" ||
    character === ";" ||
    character === "；" ||
    character === "-" ||
    character === "—"
  );
}

function afterCourtesy(value: string, courtesy: string): string | undefined {
  if (!value.startsWith(courtesy)) {
    return undefined;
  }
  let index = courtesy.length;
  if (!isMetaSeparator(value[index])) {
    return undefined;
  }
  while (isMetaSeparator(value[index])) {
    index += 1;
  }
  return value.slice(index);
}

function matchesChineseMetaTokens(
  value: string,
  actionStart: number,
  nouns: readonly string[],
): boolean {
  for (const action of chineseActions) {
    if (!value.startsWith(action, actionStart)) {
      continue;
    }
    const suffixStart = actionStart + action.length;
    if (!value.startsWith("后的", suffixStart)) {
      continue;
    }
    const nounStart = suffixStart + 2;
    if (nouns.some((noun) => value.startsWith(noun, nounStart))) {
      return true;
    }
  }
  return false;
}

function startsWithChineseMetaCore(value: string): boolean {
  for (const presentation of chinesePresentations) {
    if (
      value.startsWith(presentation) &&
      matchesChineseMetaTokens(
        value,
        presentation.length,
        chinesePresentationNouns,
      )
    ) {
      return true;
    }
  }
  return matchesChineseMetaTokens(value, 0, ["文本"]);
}

function matchesEnglishMetaTokens(
  value: string,
  actionStart: number,
  nouns: readonly string[],
): boolean {
  for (const action of englishActions) {
    if (!value.startsWith(action, actionStart)) {
      continue;
    }
    if (value[actionStart + action.length] !== " ") {
      continue;
    }
    for (const noun of nouns) {
      const phrase = `${action} ${noun}`;
      if (!value.startsWith(phrase, actionStart)) {
        continue;
      }
      const boundary = value[actionStart + phrase.length];
      if (
        boundary === undefined ||
        isMetaSeparator(boundary)
      ) {
        return true;
      }
    }
  }
  return false;
}

function startsWithEnglishMetaCore(value: string): boolean {
  for (const introduction of englishIntroductions) {
    if (
      value.startsWith(introduction) &&
      matchesEnglishMetaTokens(
        value,
        introduction.length,
        englishPresentationNouns,
      )
    ) {
      return true;
    }
  }
  return matchesEnglishMetaTokens(value, 0, ["text"]);
}

function startsWithMetaPreamble(value: string): boolean {
  const prefix = [...value.trim()]
    .slice(0, META_PREFIX_MAX_CODE_POINTS)
    .join("")
    .toLowerCase();
  if (
    startsWithChineseMetaCore(prefix) ||
    startsWithEnglishMetaCore(prefix)
  ) {
    return true;
  }

  for (const courtesy of chineseCourtesies) {
    const remainder = afterCourtesy(prefix, courtesy);
    if (
      remainder !== undefined &&
      startsWithChineseMetaCore(remainder)
    ) {
      return true;
    }
  }
  for (const courtesy of englishCourtesies) {
    const remainder = afterCourtesy(prefix, courtesy);
    if (
      remainder !== undefined &&
      startsWithEnglishMetaCore(remainder)
    ) {
      return true;
    }
  }
  return false;
}

export function validateFinalText(value: unknown): string {
  const original = validatedProviderText(value);
  if (
    startsWithMetaPreamble(original) ||
    hasHtmlSyntax(original) ||
    hasMarkdownBlockSyntax(original) ||
    hasMarkdownInlineSyntax(original)
  ) {
    throw new Error("Provider returned impure final text");
  }
  return original.trim();
}
