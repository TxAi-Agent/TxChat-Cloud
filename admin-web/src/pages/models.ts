import { listWorkspace, detailDrawer, createDraftDrawer, translated } from "./listWorkspace.js";
import { AdminApiError } from "../api.js";
import { button, detailList, section, clearFormValue, failed, field, formValue, object, rows, table, toolbar, type PageContext } from "./shared.js";

export async function renderModelsPage(context: PageContext): Promise<void> {
  const draftForm = document.createElement("form"); draftForm.className = "tx-grid-form";
  draftForm.append(field("显示名称", "displayName"), field("Provider", "providerKind"), field("模型 ID", "modelId"),
    field("WSS Endpoint", "endpoint", "url"), field("凭据", "credential", "password"));
  const create = document.createElement("button"); create.type = "submit"; create.className = "tx-button tx-button-primary"; create.textContent = "创建模型"; draftForm.append(create);
  const draft = createDraftDrawer(context, "新建模型", draftForm, create);
  const search = document.createElement("form"); search.className = "tx-inline-form"; search.append(field("ID", "idPrefix"));
  const submit = document.createElement("button"); submit.type = "submit"; submit.className = "tx-button tx-button-primary"; submit.textContent = "查询"; search.append(submit);
  const list = listWorkspace(context, search, () => load(), { keyword: "名称 / 模型", states: ["draft", "validating", "standby", "active", "draining", "unhealthy", "pending_deletion"] });
  const testNotice = document.createElement("p"); testNotice.className = "tx-notice tx-warning";
  testNotice.setAttribute("role", "alert"); testNotice.hidden = true;
  let requiresRefresh = false;
  let loadGeneration = 0;
  const warn = (message: string) => { testNotice.textContent = message; testNotice.hidden = false; };
  const canMutate = () => {
    if (!requiresRefresh) return true;
    warn("模型状态未刷新，请先查询最新状态，再尝试操作。"); return false;
  };
  const load = async (preserveOnFailure = false): Promise<void> => {
    // A new refresh invalidates both successful and failed older requests.
    const generation = ++loadGeneration;
    try {
    const response = await list.request("/console/api/v1/model-configurations"); if (response === null) return; const status = object(response.status);
    if (generation !== loadGeneration) return;
    requiresRefresh = false; testNotice.hidden = true; testNotice.textContent = "";
    list.show(() => {
    const controls = toolbar(search, draft.trigger, button("回滚到备用模型", async () => {
      if (!canMutate()) return;
      if (!window.confirm("确认回滚到已验证的备用模型？")) return;
      await context.api.request("/console/api/v1/model-configurations/rollback", { method: "POST", body: { capability: "realtime-asr" } }); await load();
    }, "warning"));
    controls.prepend(Object.assign(document.createElement("span"), { textContent: `运行状态：${translated(status.status)}` }));
    return [controls, testNotice, table(rows(response.models), [
      { key: "id", label: "ID" }, { key: "displayName", label: "名称" }, { key: "modelId", label: "模型" },
      { key: "providerKind", label: "Provider" }, { key: "endpoint", label: "WSS Endpoint" },
      { key: "credentialConfigured", label: "凭据已配置" }, { key: "lifecycleState", label: "状态", format: translated },
      { key: "validationStatus", label: "验证", format: translated }, { key: "lastValidatedAt", label: "最近验证时间" },
    ], (row) => {
      const detail = button("详情", (origin) => detailDrawer(context, origin, "模型详情", async () => [section("基本信息", detailList([
      { label: "ID", value: row.id },
      { label: "名称", value: row.displayName },
      { label: "模型", value: row.modelId },
      { label: "服务商", value: row.providerKind },
      { label: "连接地址", value: row.endpoint },
      { label: "凭据已配置", value: row.credentialConfigured },
      { label: "状态", value: translated(row.lifecycleState) },
      { label: "验证结果", value: translated(row.validationStatus) },
      { label: "最近验证时间", value: row.lastValidatedAt },
    ]))]));
      if (row.lifecycleState === "draft") return [detail, button("测试", async () => {
        if (!canMutate()) return;
        testNotice.hidden = true; testNotice.textContent = "";
        try {
          await context.api.request(`/console/api/v1/model-configurations/${String(row.id)}/test`, { method: "POST", body: { expectedRevision: row.revision } });
          await load();
        } catch (error) {
          if (!(error instanceof AdminApiError) || error.code !== "ADMIN_MODEL_TEST_FAILED" || error.status !== 409) throw error;
          // Failed validation can advance the revision. Never retry a mutation
          // automatically or let retained rows dispatch with an old revision.
          requiresRefresh = true;
          await load(true);
        } finally { clearFormValue(draftForm, "credential"); }
      })];
      if (row.lifecycleState === "standby" && row.validationStatus === "passed") return [detail, button("启用", async () => {
        if (!canMutate()) return;
        if (!window.confirm(`确认启用模型 ${String(row.displayName)}？`)) return;
        await context.api.request(`/console/api/v1/model-configurations/${String(row.id)}/activate`, { method: "POST", body: { expectedRevision: row.revision } }); await load();
      }, "primary")];
      return [detail];
    })];
    });
    if (preserveOnFailure) warn("模型测试未通过。状态已刷新，可检查配置后再次测试。");
  } catch (error) {
    if (generation !== loadGeneration) return;
    if (preserveOnFailure && !(error instanceof AdminApiError && (error.status === 401 || error.status === 403))) {
      requiresRefresh = true; warn("模型测试未通过，状态刷新失败。请先查询最新状态，再尝试操作。");
    } else if (error instanceof AdminApiError && (error.status === 401 || error.status === 403)) failed();
    else list.error();
  } };
  draftForm.addEventListener("submit", (event) => {
    event.preventDefault(); if (create.disabled || context.isCurrent?.() === false) return;
    draft.setBusy(true);
    void (async () => {
    try {
      if (!canMutate()) return;
      await context.api.request("/console/api/v1/model-configurations", { method: "POST", body: {
        capability: "realtime-asr", displayName: formValue(draftForm, "displayName"),
        providerKind: formValue(draftForm, "providerKind"), modelId: formValue(draftForm, "modelId"),
        endpoint: formValue(draftForm, "endpoint"), credential: formValue(draftForm, "credential"),
      } }); draftForm.reset(); draft.close(); if (context.isCurrent?.() !== false) await load();
    } finally { clearFormValue(draftForm, "credential"); }
  })().catch(() => draft.error("未能确认保存结果，已保留填写内容。请先查询列表确认后重试。")).finally(() => draft.setBusy(false)); });
  search.addEventListener("submit", (event) => { event.preventDefault(); list.reset(); void load(); }); await load();
}
