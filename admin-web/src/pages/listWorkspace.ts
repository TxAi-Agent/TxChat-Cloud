import { button, field, formValue, notice, object, selectField, show, type DataRow, type PageContext } from "./shared.js";

export const labels: Readonly<Record<string, string>> = {
  enabled: "启用", disabled: "禁用", draft: "待发布", scheduled: "待生效", active: "生效中",
  retired: "已失效", paused: "已暂停", pending: "待支付", paid: "已支付", expired: "已过期",
  refunded: "已退款", payment_exception: "支付异常", published: "已发布", superseded: "已替代",
  normal: "普通更新", forced: "强制更新", administrator: "管理员", super_admin: "超级管理员",
  standby: "备用", passed: "通过", failed: "失败", untested: "未测试", not_tested: "未测试",
  not_validated: "未验证", unknown: "未知", available: "可用", unavailable: "不可用",
  recorded: "已记录", confirmed: "已确认", exception: "异常", success: "成功", duplicate: "重复",
  validating: "验证中", testing: "测试中", draining: "切换中", unhealthy: "异常", pending_deletion: "待删除",
  publishing: "发布中", publish_failed: "发布失败", ready: "就绪", unconfigured: "未配置",
  accepted: "已受理", rejected: "已拒绝", uncertain: "结果未确认", deleted: "已删除",
  application: "应用", authentication: "登录认证", dictation: "听写", insertion: "文本插入",
  update: "版本更新", custom_asr: "自定义语音识别", custom_optimization: "自定义文本优化",
  membership: "会员套餐", addon: "加量包", standard: "标准", calendar_month: "自然月", calendar_year: "自然年",
};
export function translated(value: unknown): string {
  return typeof value === "string" ? labels[value] ?? value : "—";
}

/** Filters and pagination are shared, while each page retains its business actions. */
export function listWorkspace(context: PageContext, search: HTMLFormElement, reload: () => Promise<void>,
  options: { keyword: string; states?: readonly string[]; statusLabel?: string; stateLabels?: Readonly<Record<string, string>> }): {
    request: (endpoint: string) => Promise<DataRow | null>;
    reset: () => void;
    error: () => void;
    show: (...content: Array<HTMLElement | (() => readonly HTMLElement[])>) => void;
  } {
  context.root.dataset.listView = "list";
  search.classList.add("tx-users-search");
  const id = search.querySelector<HTMLInputElement>('input[name="idPrefix"]');
  if (id) { id.maxLength = 32; id.placeholder = "输入完整 ID 或前缀"; }
  const keyword = field(options.keyword, "keyword");
  const submit = search.querySelector('button[type="submit"]');
  search.insertBefore(keyword, submit);
  if (options.states) search.insertBefore(selectField(options.statusLabel ?? "状态", "status", [
    { value: "", label: "全部" }, ...options.states.map((value) => ({ value, label: options.stateLabels?.[value] ?? translated(value) })),
  ]), submit);
  let page = 1;
  let pageSize = 20;
  let total = 0;
  let totalPages = 1;
  let generation = 0;
  let applied: Record<string, string> | undefined;
  const sizeField = selectField("每页显示", "pageSize", [20, 50, 100].map((value) => ({ value: String(value), label: `${value} 条` })));
  sizeField.querySelector("select")!.addEventListener("change", () => {
    pageSize = Number(sizeField.querySelector("select")!.value); page = 1; void reload();
  });
  const pagination = () => {
    const bar = document.createElement("nav"); bar.className = "tx-users-pagination";
    bar.setAttribute("aria-label", "列表分页");
    const summary = document.createElement("span"); summary.className = "tx-users-page-summary";
    summary.setAttribute("role", "status"); summary.textContent = `第 ${page} 页，共 ${totalPages} 页 · 共 ${total} 条`;
    const previous = button("上一页", async () => { page -= 1; await reload(); }); previous.disabled = page <= 1;
    const next = button("下一页", async () => { page += 1; await reload(); }); next.disabled = page >= totalPages;
    bar.append(summary, sizeField, previous, next); return bar;
  };
  return {
    reset: () => { page = 1; applied = undefined; },
    error: () => {
      if (context.isCurrent?.() === false) return;
      const message = notice("列表加载失败，请检查筛选条件后重新查询，或重试。");
      message.setAttribute("role", "alert");
      show(context.root, () => [search, message, button("重试", reload)]);
    },
    request: async (endpoint) => {
      const version = ++generation;
      if (!applied) {
        applied = {};
        for (const name of ["idPrefix", "userId", "keyword", "status"]) {
          const value = formValue(search, name); if (value) applied[name] = value;
        }
      }
      context.root.setAttribute("aria-busy", "true");
      context.root.querySelectorAll<HTMLButtonElement | HTMLSelectElement>(".tx-users-pagination button, .tx-users-pagination select")
        .forEach((control) => { control.disabled = true; });
      try {
        const response = object(await context.api.request(endpoint, { query: { ...applied, page: String(page), limit: String(pageSize) } }));
        if (version !== generation || context.isCurrent?.() === false) return null;
        const info = object(response.pagination);
        if (![info.page, info.pageSize, info.total, info.totalPages].every((value) => typeof value === "number" && Number.isSafeInteger(value)) ||
          Number(info.page) < 1 || Number(info.total) < 0 || Number(info.totalPages) < Number(info.page) || info.pageSize !== pageSize) {
          throw new Error("Invalid list pagination");
        }
        page = Number(info.page); total = Number(info.total); totalPages = Number(info.totalPages);
        return response;
      } catch (error) {
        if (version !== generation || context.isCurrent?.() === false) return null;
        throw error;
      } finally {
        if (version === generation && context.isCurrent?.() !== false) {
          context.root.setAttribute("aria-busy", "false");
          sizeField.querySelector("select")!.disabled = false;
        }
      }
    },
    show: (...content) => {
      if (context.isCurrent?.() === false) return;
      show(context.root, ...content, () => [pagination()]);
    },
  };
}

let drawerId = 0;
export function detailDrawer(context: PageContext, origin: HTMLButtonElement, titleText: string,
  content: () => Promise<readonly HTMLElement[]>): void {
  const dialog = document.createElement("dialog"); dialog.className = "tx-user-drawer";
  const heading = document.createElement("h2"); heading.id = `tx-list-detail-${++drawerId}`; heading.textContent = titleText;
  dialog.setAttribute("aria-labelledby", heading.id);
  const header = document.createElement("header"); header.className = "tx-user-drawer-header";
  const close = button("×", () => dialog.close()); close.className = "tx-user-drawer-close";
  close.setAttribute("aria-label", `关闭${titleText}`); header.append(heading, close);
  const body = document.createElement("div"); body.className = "tx-user-drawer-body";
  dialog.append(header, body);
  let generation = 0;
  const load = async () => {
    const version = ++generation;
    body.replaceChildren(notice(`正在加载${titleText}…`));
    try {
      const children = await content();
      if (version === generation && dialog.open && context.isCurrent?.() !== false) body.replaceChildren(...children);
    } catch {
      if (version === generation && dialog.open && context.isCurrent?.() !== false) {
        const error = notice(`${titleText}加载失败，请重试。`); error.setAttribute("role", "alert");
        body.replaceChildren(error, button("重试", load));
      }
    }
  };
  dialog.addEventListener("close", () => { generation++; dialog.remove();
    if (origin.isConnected && context.isCurrent?.() !== false) origin.focus({ preventScroll: true });
  });
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); dialog.close(); });
  context.root.append(dialog); dialog.showModal(); close.focus({ preventScroll: true }); void load();
}

/** Editing stays explicit; the native details control preserves unsaved inputs across list refreshes. */
export function draftPanel(label: string, form: HTMLFormElement): HTMLDetailsElement {
  const panel = document.createElement("details"); panel.className = "tx-list-draft";
  const summary = document.createElement("summary"); summary.textContent = label;
  panel.append(summary, form); return panel;
}

export function createDraftDrawer(context: PageContext, titleText: string, form: HTMLFormElement,
  submit: HTMLButtonElement): {
    trigger: HTMLButtonElement; close: () => void; setBusy: (busy: boolean) => void;
    error: (message: string) => void;
  } {
  form.id ||= `tx-create-form-${++drawerId}`;
  form.classList.add("tx-create-drawer-form");
  submit.setAttribute("form", form.id); submit.remove();
  let active: HTMLDialogElement | undefined;
  let busy = false;
  let closing: HTMLButtonElement[] = [];
  const message = document.createElement("p"); message.className = "tx-form-error";
  message.setAttribute("role", "alert"); message.hidden = true;
  const trigger = button(titleText, (origin) => {
    if (active?.open) return;
    const drawer = document.createElement("dialog"); drawer.className = "tx-user-drawer";
    const header = document.createElement("header"); header.className = "tx-user-drawer-header";
    const title = document.createElement("h2"); title.id = `tx-create-title-${++drawerId}`; title.textContent = titleText;
    drawer.setAttribute("aria-labelledby", title.id);
    const close = button("×", () => { if (!busy) drawer.close(); }); close.className = "tx-user-drawer-close";
    close.setAttribute("aria-label", `关闭${titleText}`);
    const cancel = button("取消", () => { if (!busy) drawer.close(); }); closing = [close, cancel];
    header.append(title, close);
    const body = document.createElement("div"); body.className = "tx-user-drawer-body";
    body.append(form, message);
    const footer = document.createElement("footer"); footer.className = "tx-user-drawer-footer tx-create-draft-footer";
    footer.append(cancel, submit); drawer.append(header, body, footer);
    drawer.addEventListener("cancel", (event) => { event.preventDefault(); if (!busy) drawer.close(); });
    drawer.addEventListener("close", () => {
      drawer.remove(); if (active === drawer) active = undefined;
      if (origin.isConnected && context.isCurrent?.() !== false) origin.focus({ preventScroll: true });
    });
    active = drawer; context.root.append(drawer); drawer.showModal();
    (form.querySelector<HTMLElement>("input:not([readonly]), textarea:not([readonly]), select") ?? close).focus({ preventScroll: true });
  }, "primary");
  return {
    trigger, close: () => active?.close(),
    setBusy: (value) => {
      busy = value; form.inert = value; submit.disabled = value;
      closing.forEach((control) => { control.disabled = value; });
      if (value) message.hidden = true;
    },
    error: (text) => { message.textContent = text; message.hidden = false; },
  };
}
