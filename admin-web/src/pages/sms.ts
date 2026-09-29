import { listWorkspace, detailDrawer, createDraftDrawer, translated } from "./listWorkspace.js";
import { button, detailList, section, clearFormValue, failed, field, formValue, object, rows, table, toolbar, type PageContext } from "./shared.js";

export async function renderSmsPage(context: PageContext): Promise<void> {
  const draftForm = document.createElement("form"); draftForm.className = "tx-inline-form";
  draftForm.append(field("模板 Code", "templateCode"), field("AccessKey ID", "accessKeyId"), field("AccessKey Secret", "accessKeySecret", "password"));
  const save = document.createElement("button"); save.type = "submit"; save.className = "tx-button tx-button-primary"; save.textContent = "保存配置"; draftForm.append(save);
  const draft = createDraftDrawer(context, "新建短信配置", draftForm, save);
  const search = document.createElement("form"); search.className = "tx-inline-form"; search.append(field("ID", "idPrefix"));
  const submit = document.createElement("button"); submit.type = "submit"; submit.className = "tx-button tx-button-primary"; submit.textContent = "查询"; search.append(submit);
  const list = listWorkspace(context, search, () => load(), { keyword: "模板 Code", states: ["draft", "active", "standby", "retired"] });
  const load = async (): Promise<void> => { try {
    const response = await list.request("/console/api/v1/sms-configurations"); if (response === null) return; const status = object(response.status);
    list.show(() => {
    const controls = toolbar(search, draft.trigger, button("回滚到备用配置", async () => {
      if (!window.confirm("确认回滚到已验证的备用短信配置？")) return;
      await context.api.request("/console/api/v1/sms-configurations/rollback", { method: "POST" }); await load();
    }, "warning"));
    return [controls, table(rows(response.configurations), [
      { key: "id", label: "ID" }, { key: "templateCode", label: "模板 Code" },
      { key: "credentialsConfigured", label: "凭据已配置" }, { key: "lifecycle", label: "状态", format: translated },
      { key: "lastTestOutcome", label: "测试结果", format: translated }, { key: "updatedAt", label: "更新时间" },
    ], (row) => [button("详情", (origin) => detailDrawer(context, origin, "短信配置详情", async () => [section("基本信息", detailList([
      { label: "ID", value: row.id },
      { label: "模板编码", value: row.templateCode },
      { label: "凭据已配置", value: row.credentialsConfigured },
      { label: "状态", value: translated(row.lifecycle) },
      { label: "测试结果", value: translated(row.lastTestOutcome) },
      { label: "创建时间", value: row.createdAt },
      { label: "更新时间", value: row.updatedAt },
    ]))])), ...(row.lifecycle === "draft" ? [button("测试", async () => {
      const phone = window.prompt("输入本次测试手机号（不会保存）", "+86"); if (phone === null) return;
      await context.api.request(`/console/api/v1/sms-configurations/${String(row.id)}/test`, { method: "POST", body: { expectedRevision: row.revision, phone } }); await load();
    }), button("启用", async () => {
      if (!window.confirm(`确认启用短信配置 ${String(row.id)}？`)) return;
      await context.api.request(`/console/api/v1/sms-configurations/${String(row.id)}/activate`, { method: "POST", body: { expectedRevision: row.revision } }); await load();
    }, "primary")] : [])])];
    });
    void status;
  } catch { list.error(); } };
  draftForm.addEventListener("submit", (event) => {
    event.preventDefault(); if (save.disabled || context.isCurrent?.() === false) return;
    draft.setBusy(true);
    void (async () => {
    try {
      const current = object(await context.api.request("/console/api/v1/sms-configurations", { query: { limit: "100" } })); const currentDraft = object(object(current.status).draft);
      await context.api.request("/console/api/v1/sms-configurations", { method: "POST", body: {
        expectedRevision: typeof currentDraft.revision === "number" ? currentDraft.revision : null,
        templateCode: formValue(draftForm, "templateCode"), accessKeyId: formValue(draftForm, "accessKeyId"),
        accessKeySecret: formValue(draftForm, "accessKeySecret"),
      } }); draftForm.reset(); draft.close(); if (context.isCurrent?.() !== false) await load();
    } finally {
      clearFormValue(draftForm, "accessKeyId"); clearFormValue(draftForm, "accessKeySecret");
    }
  })().catch(() => draft.error("未能确认保存结果，已保留填写内容。请先查询列表确认后重试。")).finally(() => draft.setBusy(false)); });
  search.addEventListener("submit", (event) => { event.preventDefault(); list.reset(); void load(); }); await load();
}
