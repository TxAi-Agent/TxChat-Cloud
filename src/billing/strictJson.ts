class JsonStructureValidator {
  readonly #source: string;
  readonly #maximumDepth: number;
  #index = 0;

  constructor(source: string, maximumDepth: number) {
    this.#source = source;
    this.#maximumDepth = maximumDepth;
  }

  validate(): void {
    this.#skipWhitespace();
    this.#parseValue(0);
    this.#skipWhitespace();
    if (this.#index !== this.#source.length) {
      throw new Error("trailing JSON input");
    }
  }

  #parseValue(depth: number): void {
    if (depth > this.#maximumDepth) {
      throw new Error("JSON nesting too deep");
    }
    const token = this.#source[this.#index];
    if (token === "{") {
      this.#parseObject(depth + 1);
      return;
    }
    if (token === "[") {
      this.#parseArray(depth + 1);
      return;
    }
    if (token === '"') {
      this.#parseString();
      return;
    }
    if (token === "-") {
      this.#parseNumber();
      return;
    }
    if (token !== undefined && token >= "0" && token <= "9") {
      this.#parseNumber();
      return;
    }
    for (const literal of ["true", "false", "null"] as const) {
      if (this.#source.startsWith(literal, this.#index)) {
        this.#index += literal.length;
        return;
      }
    }
    throw new Error("invalid JSON value");
  }

  #parseObject(depth: number): void {
    this.#index += 1;
    this.#skipWhitespace();
    if (this.#source[this.#index] === "}") {
      this.#index += 1;
      return;
    }
    const keys = new Set<string>();
    while (true) {
      if (this.#source[this.#index] !== '"') {
        throw new Error("invalid JSON object key");
      }
      const key = this.#parseString();
      if (keys.has(key)) {
        throw new Error("duplicate JSON object key");
      }
      keys.add(key);
      this.#skipWhitespace();
      if (this.#source[this.#index] !== ":") {
        throw new Error("missing JSON colon");
      }
      this.#index += 1;
      this.#skipWhitespace();
      this.#parseValue(depth);
      this.#skipWhitespace();
      const separator = this.#source[this.#index];
      if (separator === "}") {
        this.#index += 1;
        return;
      }
      if (separator !== ",") {
        throw new Error("invalid JSON object separator");
      }
      this.#index += 1;
      this.#skipWhitespace();
    }
  }

  #parseArray(depth: number): void {
    this.#index += 1;
    this.#skipWhitespace();
    if (this.#source[this.#index] === "]") {
      this.#index += 1;
      return;
    }
    while (true) {
      this.#parseValue(depth);
      this.#skipWhitespace();
      const separator = this.#source[this.#index];
      if (separator === "]") {
        this.#index += 1;
        return;
      }
      if (separator !== ",") {
        throw new Error("invalid JSON array separator");
      }
      this.#index += 1;
      this.#skipWhitespace();
    }
  }

  #parseString(): string {
    const start = this.#index;
    this.#index += 1;
    while (this.#index < this.#source.length) {
      const character = this.#source[this.#index]!;
      if (character === '"') {
        this.#index += 1;
        return JSON.parse(this.#source.slice(start, this.#index)) as string;
      }
      if (character === "\\") {
        this.#index += 1;
        const escape = this.#source[this.#index];
        if (escape === "u") {
          const hexadecimal = this.#source.slice(
            this.#index + 1,
            this.#index + 5,
          );
          if (!/^[0-9A-Fa-f]{4}$/u.test(hexadecimal)) {
            throw new Error("invalid JSON unicode escape");
          }
          this.#index += 5;
          continue;
        }
        if (escape === undefined || !'"\\/bfnrt'.includes(escape)) {
          throw new Error("invalid JSON escape");
        }
        this.#index += 1;
        continue;
      }
      if (character.charCodeAt(0) <= 0x1f) {
        throw new Error("invalid JSON control character");
      }
      this.#index += 1;
    }
    throw new Error("unterminated JSON string");
  }

  #parseNumber(): void {
    const remainder = this.#source.slice(this.#index);
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(
      remainder,
    );
    if (match === null) {
      throw new Error("invalid JSON number");
    }
    this.#index += match[0].length;
  }

  #skipWhitespace(): void {
    while (/^[\t\n\r ]$/u.test(this.#source[this.#index] ?? "")) {
      this.#index += 1;
    }
  }
}

export function parseStrictJson(
  source: string,
  maximumDepth = 128,
): unknown {
  if (
    typeof source !== "string" ||
    !source.isWellFormed() ||
    !Number.isSafeInteger(maximumDepth) ||
    maximumDepth < 1 ||
    maximumDepth > 256
  ) {
    throw new TypeError("Invalid strict JSON input");
  }
  new JsonStructureValidator(source, maximumDepth).validate();
  return JSON.parse(source) as unknown;
}
