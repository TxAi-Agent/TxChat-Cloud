import type { AdminApiClient } from "../api.js";
import type { AdminMenuCode } from "../navigation.js";
import { renderInternalIdCell, showTableState } from "../tables.js";

export type PageFilters = Readonly<{ userId?: string }>;

export type PageContext = Readonly<{
  api: AdminApiClient;
  root: HTMLElement;
  accountKind?: "super_admin" | "administrator";
  isCurrent?: () => boolean;
  initialFilters?: PageFilters;
  canNavigate?: (menu: AdminMenuCode) => boolean;
  navigate: (menu: AdminMenuCode, filters?: PageFilters) => void;
}>;
export type DataRow = Readonly<Record<string, unknown>>;
export type Column = Readonly<{ key: string; label: string; copyId?: boolean; format?: (value: unknown, row: DataRow) => string }>;

export function object(value: unknown): DataRow {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as DataRow : {};
}

export function rows(value: unknown): readonly DataRow[] {
  return Array.isArray(value) ? value.map(object) : [];
}

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
export function valueText(value: unknown): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/u.test(value) && Number.isFinite(Date.parse(value))) {
    const parts = Object.fromEntries(dateFormat.formatToParts(new Date(value)).map(({ type, value }) => [type, value]));
    return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  }
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return "—";
}

export function button(label: string, action: (control: HTMLButtonElement) => void | Promise<void>, kind = "secondary"): HTMLButtonElement {
  const control = document.createElement("button");
  control.type = "button"; control.className = `tx-button tx-button-${kind}`; control.textContent = label;
  control.addEventListener("click", () => {
    control.disabled = true;
    void Promise.resolve(action(control)).catch(failed).finally(() => {
      control.disabled = false;
    });
  });
  return control;
}

/** Only read-only detail pages opt in; Escape never discards an edit form. */
export function detailBackButton(root: HTMLElement, origin: HTMLButtonElement, load: () => Promise<void>): HTMLButtonElement {
  const key = origin.dataset.rowActionKey;
  const back = button("返回列表", async () => {
    await load();
    if (root.hidden || key === undefined) return;
    const restored = Array.from(root.querySelectorAll<HTMLElement>("[data-row-action-key]"))
      .find((control) => control.dataset.rowActionKey === key);
    restored?.focus();
    restored?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
  back.dataset.detailBack = "true";
  return back;
}

export function field(label: string, name: string, type = "text"): HTMLLabelElement {
  const wrapper = document.createElement("label"); wrapper.className = "tx-field";
  const title = document.createElement("span"); title.textContent = label;
  const input = document.createElement("input"); input.name = name; input.type = type; input.className = "form-control";
  wrapper.append(title, input); return wrapper;
}

export function selectField(
  label: string,
  name: string,
  options: readonly Readonly<{ value: string; label: string }>[],
): HTMLLabelElement {
  const wrapper = document.createElement("label"); wrapper.className = "tx-field";
  const title = document.createElement("span"); title.textContent = label;
  const select = document.createElement("select"); select.name = name; select.className = "form-control";
  for (const option of options) {
    const element = document.createElement("option"); element.value = option.value; element.textContent = option.label;
    select.append(element);
  }
  wrapper.append(title, select); return wrapper;
}

export function formValue(form: HTMLFormElement, name: string): string {
  const value = new FormData(form).get(name);
  return typeof value === "string" ? value.trim() : "";
}

export function clearFormValue(form: HTMLFormElement, name: string): void {
  const control = form.elements.namedItem(name);
  if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) control.value = "";
}

export function toolbar(...children: HTMLElement[]): HTMLElement {
  const area = document.createElement("div"); area.className = "tx-toolbar"; area.append(...children); return area;
}

export function detailList(
  entries: readonly Readonly<{ label: string; value: unknown }>[],
): HTMLElement {
  const list = document.createElement("dl"); list.className = "tx-detail-grid";
  for (const entry of entries) {
    const item = document.createElement("div");
    const term = document.createElement("dt"); term.textContent = entry.label;
    const description = document.createElement("dd"); description.textContent = valueText(entry.value);
    item.append(term, description); list.append(item);
  }
  return list;
}

export function section(title: string, ...children: HTMLElement[]): HTMLElement {
  const element = document.createElement("section"); element.className = "tx-section";
  const heading = document.createElement("h2"); heading.textContent = title;
  element.append(heading, ...children); return element;
}

export function durationText(value: unknown): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return "—";
  const minutes = value / 60_000;
  if (minutes > 0 && minutes < 0.01) return "小于 0.01 分钟";
  return `${Number(minutes.toFixed(2))} 分钟`;
}

export function notice(text: string, tone: "normal" | "warning" = "normal"): HTMLElement {
  const element = document.createElement("p"); element.className = tone === "warning" ? "tx-notice tx-warning" : "tx-notice";
  element.textContent = text; return element;
}

export function table(
  data: readonly DataRow[], columns: readonly Column[],
  actions?: (row: DataRow) => readonly HTMLElement[],
): HTMLDivElement {
  const element = document.createElement("table"); element.className = "table table-vcenter tx-table";
  const head = document.createElement("thead"); const header = document.createElement("tr");
  for (const column of columns) { const cell = document.createElement("th"); cell.textContent = column.label; header.append(cell); }
  if (actions !== undefined) { const cell = document.createElement("th"); cell.textContent = "操作"; header.append(cell); }
  head.append(header); const body = document.createElement("tbody");
  if (data.length === 0) {
    const line = document.createElement("tr"); const cell = document.createElement("td");
    cell.setAttribute("colspan", String(columns.length + (actions === undefined ? 0 : 1)));
    cell.textContent = "暂无数据"; cell.className = "tx-empty-row";
    line.append(cell); body.append(line);
  }
  for (const row of data) {
    const line = document.createElement("tr");
    for (const column of columns) {
      const raw = row[column.key];
      if (column.key === "id" && column.copyId === true && typeof raw === "string") line.append(renderInternalIdCell(raw));
      else { const cell = document.createElement("td"); cell.textContent = column.format?.(raw, row) ?? valueText(raw); line.append(cell); }
    }
    if (actions !== undefined) {
      const cell = document.createElement("td"); cell.className = "tx-row-actions";
      const controls = actions(row);
      if (typeof row.id === "string") controls.forEach((control, index) => { control.dataset.rowActionKey = `${row.id}:${index}`; });
      cell.append(...controls); line.append(cell);
    }
    body.append(line);
  }
  element.append(head, body);
  // Only the table scrolls; focusing its last column must not shift live forms.
  const viewport = document.createElement("div"); viewport.className = "tx-table-scroll";
  viewport.addEventListener("focusin", (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && target !== viewport && viewport.contains(target)) {
      target.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  });
  viewport.append(element); return viewport;
}

const keyboardRoots = new WeakSet<HTMLElement>();
// Reused live controls must be constructed lazily: reparenting a focused form
// into a detached toolbar already drops browser focus before replaceChildren.
export function show(root: HTMLElement, ...content: Array<HTMLElement | (() => readonly HTMLElement[])>): void {
  const focused = document.activeElement;
  const children = content.flatMap((item) => typeof item === "function" ? item() : [item]);
  root.replaceChildren(...children);
  root.scrollLeft = 0;
  showTableState(children.length === 0 ? "empty" : "content");
  if (focused && root.contains(focused) && "focus" in focused) (focused as HTMLElement).focus();
  else root.querySelector<HTMLElement>("[data-detail-back]")?.focus();
  if (!keyboardRoots.has(root)) {
    root.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.defaultPrevented || root.hidden) return;
      const back = root.querySelector<HTMLButtonElement>("[data-detail-back]");
      if (back === null || back.disabled) return;
      event.preventDefault(); event.stopPropagation(); back.click();
    });
    keyboardRoots.add(root);
  }
}

export function failed(): void { showTableState("error"); }
