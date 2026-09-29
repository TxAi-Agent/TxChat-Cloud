const INTERNAL_ID = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{32}$/u;

export function renderInternalIdCell(id: string): HTMLTableCellElement {
  if (!INTERNAL_ID.test(id)) throw new TypeError("Invalid internal identifier");
  const cell = document.createElement("td");
  cell.className = "tx-id-cell";
  const value = document.createElement("code");
  value.textContent = id;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tx-copy-button";
  button.dataset.copyId = id;
  button.textContent = "复制";
  button.setAttribute("aria-label", `复制 ID ${id}`);
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(id);
      button.textContent = "已复制";
      button.dataset.copyState = "complete";
    } catch {
      button.textContent = "复制失败";
      button.dataset.copyState = "failed";
    }
  });
  cell.append(value, button);
  return cell;
}

export type TableState = "content" | "loading" | "empty" | "error";

export function showTableState(state: TableState): void {
  for (const name of ["loading", "empty", "error"] as const) {
    const element = document.querySelector<HTMLElement>(`#admin-${name}`);
    if (element !== null) element.hidden = state !== name;
  }
  const content = document.querySelector<HTMLElement>("#admin-content");
  if (content !== null) content.hidden = state !== "content";
}

export function renderPagination(
  container: HTMLElement,
  input: Readonly<{
    page: number;
    pageCount: number;
    onPage: (page: number) => void;
  }>,
): void {
  if (
    !Number.isSafeInteger(input.page) ||
    !Number.isSafeInteger(input.pageCount) ||
    input.page < 1 ||
    input.pageCount < 1 ||
    input.page > input.pageCount
  ) {
    throw new TypeError("Invalid pagination state");
  }
  container.replaceChildren();
  const status = document.createElement("span");
  status.textContent = `第 ${input.page} / ${input.pageCount} 页`;
  const previous = document.createElement("button");
  previous.type = "button";
  previous.textContent = "上一页";
  previous.disabled = input.page === 1;
  previous.addEventListener("click", () => input.onPage(input.page - 1));
  const next = document.createElement("button");
  next.type = "button";
  next.textContent = "下一页";
  next.disabled = input.page === input.pageCount;
  next.addEventListener("click", () => input.onPage(input.page + 1));
  container.append(previous, status, next);
}
