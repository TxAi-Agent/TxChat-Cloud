import {
  nextUniqueInternalId,
  type InternalIdGenerator,
} from "./internalId.js";

export function insertWithInternalId(input: Readonly<{
  generate?: InternalIdGenerator;
  insert(id: string): boolean;
}>): string {
  return nextUniqueInternalId({
    ...(input.generate === undefined ? {} : { generate: input.generate }),
    insert: (id) => input.insert(id) ? "inserted" : "collision",
  });
}
