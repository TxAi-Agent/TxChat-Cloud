import { AdminApiError } from "../api.js";
import {
  button, detailList, durationText, field, formValue,
  object, rows, section, selectField, show, table, toolbar,
  type DataRow, type PageContext,
} from "./shared.js";

function membership(row: DataRow): DataRow { return object(row.membership); }

function membershipText(row: DataRow): string {
  const value = membership(row);
  if (value.kind === undefined) return "—";
  const kind = value.kind === "trial" ? "体验额度" : value.kind === "monthly_membership" ? "会员套餐" : "—";
  const status = value.status === "active" ? "生效中" : value.status === "exhausted" ? "已用尽" : "—";
  return `${kind} · ${status}`;
}

function phoneText(value: unknown): string {
  if (typeof value !== "string") return "—";
  return value.replace(/^\+86(?=1[3-9][0-9]{9}$)/u, "");
}

function statusText(value: unknown): string {
  return value === "enabled" ? "启用" : value === "disabled" ? "禁用" : "—";
}

const registrationFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
function registrationText(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return "—";
  const parts = Object.fromEntries(registrationFormat.formatToParts(new Date(value))
    .map(({ type, value }) => [type, value]));
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export async function renderUsersPage(context: PageContext): Promise<void> {
  let page = 1;
  let pageSize = 20;
  let appliedFilters: Record<string, string> = {};
  let requestVersion = 0;
  const isCurrent = (version: number) => version === requestVersion && context.isCurrent?.() !== false;
  const search = document.createElement("form");
  search.className = "tx-inline-form tx-users-search";
  search.append(field("ID", "idPrefix"), field("手机号", "phone"), selectField("状态", "status", [
    { value: "", label: "全部状态" }, { value: "enabled", label: "启用" }, { value: "disabled", label: "禁用" },
  ]));
  const idInput = search.querySelector<HTMLInputElement>('input[name="idPrefix"]');
  if (idInput) { idInput.placeholder = "输入完整 ID 或前缀"; idInput.maxLength = 32; }
  const phoneInput = search.querySelector<HTMLInputElement>('input[name="phone"]');
  if (phoneInput) { phoneInput.placeholder = "输入完整手机号"; phoneInput.inputMode = "tel"; }
  const submit = document.createElement("button");
  submit.className = "tx-button tx-button-primary"; submit.type = "submit"; submit.textContent = "查询";
  search.append(submit);
  const pageSizeField = selectField("每页显示", "pageSize", [20, 50, 100].map((size) => ({ value: String(size), label: `${size} 条` })));
  const sizeSelect = pageSizeField.querySelector<HTMLSelectElement>("select")!;
  sizeSelect.value = "20";

  const showError = (error: unknown, retry: () => Promise<void>) => {
    const message = document.createElement("p");
    message.className = "tx-notice tx-form-error";
    message.setAttribute("role", "alert");
    message.textContent = error instanceof AdminApiError && error.code === "ADMIN_INVALID_REQUEST"
      ? "查询条件无效，请检查 ID 和完整手机号。"
      : "加载失败，请重试。";
    context.root.dataset.userView = "list";
    show(context.root, () => [toolbar(search), message, toolbar(button("重试", retry))]);
  };

  let activeDrawer: HTMLDialogElement | undefined;
  const showDetail = (id: string, origin: HTMLButtonElement): void => {
    activeDrawer?.close();
    const drawer = document.createElement("dialog");
    drawer.className = "tx-user-drawer";
    drawer.setAttribute("aria-labelledby", "tx-user-detail-title");
    const header = document.createElement("header");
    header.className = "tx-user-drawer-header";
    const title = document.createElement("h2");
    title.id = "tx-user-detail-title"; title.textContent = "用户详情";
    const close = document.createElement("button");
    close.type = "button"; close.className = "tx-user-drawer-close";
    close.textContent = "×"; close.setAttribute("aria-label", "关闭用户详情");
    close.addEventListener("click", () => drawer.close());
    header.append(title, close);
    const body = document.createElement("div"); body.className = "tx-user-drawer-body";
    const footer = document.createElement("footer"); footer.className = "tx-user-drawer-footer";
    drawer.append(header, body, footer);
    const viewport = context.root.querySelector<HTMLElement>(".tx-table-scroll");
    const scrollTop = viewport?.scrollTop ?? 0;
    const scrollLeft = viewport?.scrollLeft ?? 0;
    let closed = false;
    let detailVersion = 0;
    const release = () => {
      if (closed) return;
      closed = true;
      if (activeDrawer === drawer) activeDrawer = undefined;
      drawer.remove();
      if (context.isCurrent?.() === false || !origin.isConnected) return;
      origin.focus({ preventScroll: true });
      if (viewport) { viewport.scrollTop = scrollTop; viewport.scrollLeft = scrollLeft; }
    };
    drawer.addEventListener("close", release);
    drawer.addEventListener("cancel", (event) => { event.preventDefault(); drawer.close(); });
    const loadDetail = async (): Promise<void> => {
      const version = ++detailVersion;
      const loading = document.createElement("p");
      loading.className = "tx-user-drawer-message";
      loading.setAttribute("role", "status"); loading.textContent = "正在加载用户详情…";
      body.replaceChildren(loading);
      try {
        const response = object(await context.api.request(`/console/api/v1/users/${id}`));
        if (closed || !drawer.isConnected || context.isCurrent?.() === false || version !== detailVersion) return;
        const user = object(response.user); const current = membership(user);
        footer.replaceChildren();
        if (
          context.accountKind === "super_admin" &&
          user.status === "enabled" &&
          current.kind === "monthly_membership" &&
          (current.status === "active" || current.status === "exhausted")
        ) {
          footer.append(button("结束会员并恢复免费额度", async () => {
            const confirmation = `确认立即结束用户 ${String(user.id)} 的当前会员，并恢复完整免费额度？订单、支付和历史用量记录会保留。`;
            if (!window.confirm(confirmation)) return;
            try {
              await context.api.request(`/console/api/v1/users/${String(user.id)}/regrant-trial`, {
                method: "POST", body: { expectedRevision: user.revision },
              });
              await loadDetail();
            } catch (error) {
              if (error instanceof AdminApiError && error.code === "ADMIN_REVISION_CONFLICT") {
                window.alert("用户会员状态已发生变化，请按刷新后的状态重新操作。");
                await loadDetail();
              } else {
                window.alert("会员结束与免费额度恢复未完成，请刷新详情确认当前状态后重试。");
              }
            }
          }, "danger"));
        }
        if (context.canNavigate?.("orders.list") !== false) {
          footer.append(button("查看订单", () => {
            drawer.close();
            context.navigate("orders.list", { userId: id });
          }));
        }
        body.replaceChildren(
          section("基本信息", detailList([
            { label: "ID", value: user.id }, { label: "手机号", value: phoneText(user.phone) },
            { label: "状态", value: statusText(user.status) },
            { label: "注册时间", value: registrationText(user.registeredAt) },
          ])),
          section("会员与用量", detailList([
            { label: "会员", value: membershipText(user) },
            { label: "有效期", value: current.kind === "trial" && current.endsAt === null ? "不限期" : registrationText(current.endsAt) },
            { label: "总额度", value: durationText(current.totalDurationMs) },
            { label: "已用额度", value: durationText(current.usedDurationMs) },
            { label: "剩余额度", value: durationText(current.remainingDurationMs) },
            { label: "订单数", value: user.orderCount },
          ])),
        );
      } catch {
        if (closed || !drawer.isConnected || context.isCurrent?.() === false || version !== detailVersion) return;
        const message = document.createElement("p");
        message.className = "tx-user-drawer-message tx-form-error";
        message.setAttribute("role", "alert"); message.textContent = "用户详情加载失败，请重试。";
        body.replaceChildren(message, button("重试", loadDetail));
      }
    };
    context.root.append(drawer);
    activeDrawer = drawer;
    drawer.showModal();
    close.focus({ preventScroll: true });
    void loadDetail();
  };

  let changingStatus = false;
  const changeStatus = async (row: DataRow): Promise<void> => {
    if (changingStatus || context.isCurrent?.() === false) return;
    const disabling = row.status === "enabled";
    const label = disabling ? "停用" : "启用";
    const confirmation = disabling
      ? `确认停用用户 ${String(row.id)}？停用后，该用户的现有登录会话将失效。`
      : `确认启用用户 ${String(row.id)}？`;
    if (!window.confirm(confirmation)) return;
    changingStatus = true;
    const controls = [...context.root.querySelectorAll<HTMLButtonElement>(".tx-user-status-action")];
    controls.forEach((control) => { control.disabled = true; });
    try {
      await context.api.request(`/console/api/v1/users/${String(row.id)}/${disabling ? "disable" : "restore"}`, {
        method: "POST", body: { expectedRevision: row.revision },
      });
      if (context.isCurrent?.() !== false) await load();
    } catch (error) {
      if (context.isCurrent?.() === false) return;
      if (error instanceof AdminApiError && error.code === "ADMIN_REVISION_CONFLICT") {
        window.alert("用户状态已发生变化，请按刷新后的状态重新操作。");
        await load();
      } else {
        window.alert(`${label}未完成，请刷新列表确认当前状态后重试。`);
      }
    } finally {
      changingStatus = false;
      context.root.querySelectorAll<HTMLButtonElement>(".tx-user-status-action")
        .forEach((control) => { control.disabled = false; });
    }
  };

  const load = async (requestedPage = page): Promise<void> => {
    const version = ++requestVersion;
    const query = { ...appliedFilters, page: String(requestedPage), limit: String(pageSize) };
    context.root.setAttribute("aria-busy", "true");
    try {
      const response = object(await context.api.request("/console/api/v1/users", { query }));
      if (!isCurrent(version)) return;
      const pagination = object(response.pagination);
      const numbers = [pagination.page, pagination.pageSize, pagination.total, pagination.totalPages];
      if (!numbers.every((value) => typeof value === "number" && Number.isSafeInteger(value)) ||
          Number(pagination.page) < 1 || Number(pagination.total) < 0 ||
          Number(pagination.totalPages) < Number(pagination.page) ||
          Number(pagination.pageSize) !== Number(query.limit)) throw new Error("Invalid user pagination");
      page = Number(pagination.page);
      const totalPages = Number(pagination.totalPages);
      const previous = button("上一页", () => load(page - 1));
      const next = button("下一页", () => load(page + 1));
      previous.disabled = page === 1;
      next.disabled = page === totalPages;
      const summary = document.createElement("span");
      summary.className = "tx-users-page-summary";
      summary.setAttribute("role", "status");
      summary.textContent = `第 ${page} 页，共 ${totalPages} 页 · 共 ${pagination.total} 条`;
      const paginationBar = document.createElement("nav");
      paginationBar.className = "tx-users-pagination";
      paginationBar.setAttribute("aria-label", "用户列表分页");
      context.root.dataset.userView = "list";
      show(context.root, () => {
        paginationBar.append(summary, pageSizeField, previous, next);
        return [toolbar(search), table(rows(response.users), [
          { key: "id", label: "ID", copyId: false }, { key: "phone", label: "手机号", format: phoneText },
          { key: "status", label: "状态", format: statusText },
          { key: "registeredAt", label: "注册时间", format: registrationText },
        ], (row) => {
          const actions = [button("详情", (origin) => showDetail(String(row.id), origin))];
          if (row.status === "enabled" || row.status === "disabled") {
            const toggle = button(row.status === "enabled" ? "停用" : "启用", () => changeStatus(row));
            toggle.className += " tx-user-status-action";
            toggle.dataset.userStatus = String(row.status);
            toggle.disabled = changingStatus;
            actions.push(toggle);
          }
          return actions;
        }), paginationBar];
      });
    } catch (error) {
      if (isCurrent(version)) showError(error, () => load(requestedPage));
    } finally {
      if (isCurrent(version)) context.root.setAttribute("aria-busy", "false");
    }
  };
  search.addEventListener("submit", (event) => {
    event.preventDefault();
    appliedFilters = {};
    for (const name of ["idPrefix", "phone", "status"]) {
      const value = formValue(search, name);
      if (value !== "") appliedFilters[name] = value;
    }
    void load(1);
  });
  sizeSelect.addEventListener("change", () => {
    const size = Number(sizeSelect.value);
    if (![20, 50, 100].includes(size)) return;
    pageSize = size;
    void load(1);
  });
  await load();
}
