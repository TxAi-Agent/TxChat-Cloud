import { listWorkspace, detailDrawer, createDraftDrawer, translated } from "./listWorkspace.js";
import { button, detailList, section, failed, field, formValue, object, rows, table, toolbar, type PageContext } from "./shared.js";

export async function renderAccountsPage(context: PageContext): Promise<void> {
  const search = document.createElement("form"); search.className = "tx-inline-form"; search.append(field("ID", "idPrefix"));
  const submit = document.createElement("button"); submit.type = "submit"; submit.className = "tx-button tx-button-primary"; submit.textContent = "查询"; search.append(submit);
  const list = listWorkspace(context, search, () => load(), { keyword: "账户名", states: ["active"], stateLabels: { active: "正常" } });
  const createForm = document.createElement("form");
  const introduction = document.createElement("p"); introduction.textContent = "生成创建链接后，由新管理员通过链接设置账号和密码。";
  const output = field("管理员创建链接", "setupLink"); const linkInput = output.querySelector("input")!;
  linkInput.readOnly = true; output.hidden = true;
  const copy = button("复制链接", async () => {
    try { await navigator.clipboard.writeText(linkInput.value); copy.textContent = "已复制"; }
    catch { creation.error("复制失败，请选中链接手动复制。"); }
  }); copy.hidden = true;
  const issue = document.createElement("button"); issue.type = "submit";
  issue.className = "tx-button tx-button-primary"; issue.textContent = "生成创建链接";
  createForm.append(introduction, output, copy, issue);
  const creation = createDraftDrawer(context, "新建管理员", createForm, issue);
  createForm.addEventListener("submit", (event) => {
    event.preventDefault(); if (issue.disabled || context.isCurrent?.() === false) return;
    creation.setBusy(true);
    void context.api.request("/console/api/v1/accounts/setup-links", { method: "POST", body: { purpose: "create_administrator" } })
      .then((value) => {
        const issued = object(value); if (typeof issued.setupLink !== "string" || issued.setupLink === "") throw new Error("Missing setup link");
        linkInput.value = issued.setupLink; output.hidden = false; copy.hidden = false;
        copy.textContent = "复制链接"; issue.textContent = "重新生成链接";
      }).catch(() => creation.error("创建链接未生成，请稍后重试。"))
      .finally(() => creation.setBusy(false));
  });
  const load = async (): Promise<void> => { try {
    const response = await list.request("/console/api/v1/accounts"); if (response === null) return;
    list.show(() => {
    const controls = toolbar(search, creation.trigger);
    return [controls, table(rows(response.accounts), [
      { key: "id", label: "ID" }, { key: "username", label: "账户名" }, { key: "kind", label: "类型", format: translated },
      { key: "status", label: "状态", format: (value) => value === "active" ? "正常" : translated(value) }, { key: "updatedAt", label: "更新时间" },
    ], (row) => [button("详情", (origin) => detailDrawer(context, origin, "账户详情", async () => [section("基本信息", detailList([
      { label: "ID", value: row.id },
      { label: "账户名", value: row.username },
      { label: "类型", value: translated(row.kind) },
      { label: "状态", value: row.status === "active" ? "正常" : translated(row.status) },
      { label: "创建时间", value: row.createdAt },
      { label: "更新时间", value: row.updatedAt },
    ]))])), ...(row.kind === "administrator" ? [
      button("权限", async () => {
        const current = Array.isArray(row.permissions) ? row.permissions.join(",") : "";
        const supplied = window.prompt("输入逗号分隔的菜单权限", current); if (supplied === null) return;
        const permissions = supplied.split(",").map((item) => item.trim()).filter((item) => item !== "");
        await context.api.request(`/console/api/v1/accounts/${String(row.id)}/permissions`, {
          method: "PUT", body: { expectedRevision: row.revision, permissions },
        }); await load();
      }),
      button("重置链接", async () => {
        const issued = object(await context.api.request("/console/api/v1/accounts/setup-links", { method: "POST",
          body: { purpose: "reset_administrator", accountId: row.id, expectedRevision: row.revision } }));
        if (typeof issued.setupLink === "string") await navigator.clipboard.writeText(issued.setupLink);
      }),
      button("删除", async () => {
        if (!window.confirm(`确认删除管理员 ${String(row.username)}？`)) return;
        await context.api.request(`/console/api/v1/accounts/${String(row.id)}`, { method: "DELETE", body: { expectedRevision: row.revision } }); await load();
      }, "danger"),
    ] : [])])];
    });
  } catch { list.error(); } };
  search.addEventListener("submit", (event) => { event.preventDefault(); list.reset(); void load(); }); await load();
}
