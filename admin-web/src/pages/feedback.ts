import { listWorkspace, detailDrawer, translated } from "./listWorkspace.js";
import { button, detailList, durationText, failed, field, formValue, object, rows, section, table, toolbar, type PageContext } from "./shared.js";

function platformName(value: unknown): string {
  if (value === "macos") return "macOS";
  if (value === "windows") return "Windows";
  return "—";
}

export async function renderFeedbackPage(context: PageContext): Promise<void> {
  const search = document.createElement("form"); search.className = "tx-inline-form"; search.append(field("ID", "idPrefix"));
  const submit = document.createElement("button"); submit.type = "submit"; submit.className = "tx-button tx-button-primary"; submit.textContent = "查询"; search.append(submit);
  const list = listWorkspace(context, search, () => load(), { keyword: "诊断编号 / Build", statusLabel: "分类", states: ["application", "authentication", "dictation", "insertion", "update", "custom_asr", "custom_optimization"] });
  const showDetail = (id: string, origin: HTMLButtonElement) => detailDrawer(context, origin, "反馈详情", async () => {
    const response = object(await context.api.request(`/console/api/v1/feedback/${id}`));
    const feedback = object(response.feedback); const application = object(feedback.application); const system = object(feedback.system);
    const permissions = object(feedback.permissions); const incident = object(feedback.incident);
    return [
      section("反馈详情", detailList([
        { label: "ID", value: feedback.id }, { label: "诊断编号", value: feedback.diagnosticNumber },
        { label: "外部报告引用", value: feedback.externalReportId },
        { label: "发生时间", value: feedback.occurredAt }, { label: "接收时间", value: feedback.receivedAt },
        { label: "App", value: `${String(application.version ?? "—")} / Build ${String(application.build ?? "—")}` },
        { label: "语言与架构", value: `${String(application.locale ?? "—")} / ${String(application.architecture ?? "—")}` },
        { label: "平台", value: platformName(system.platform) },
        { label: "系统版本", value: `${platformName(system.platform)} ${String(system.version ?? "—")}` },
        { label: "权限", value: `麦克风 ${String(permissions.microphone ?? "—")} / 辅助功能 ${String(permissions.accessibility ?? "—")}` },
        { label: "服务模式", value: feedback.serviceMode },
        { label: "异常", value: `${String(incident.category ?? "—")} / ${String(incident.stage ?? "—")} / ${String(incident.code ?? "—")}` },
      ])),
      section("结构化事件", table(rows(feedback.events), [
        { key: "index", label: "序号" }, { key: "occurredAt", label: "时间" },
        { key: "category", label: "分类" }, { key: "stage", label: "阶段" },
        { key: "code", label: "错误码" }, { key: "durationMs", label: "耗时", format: durationText },
        { key: "httpStatus", label: "HTTP 状态" },
      ])),
    ];
  });
  const load = async (): Promise<void> => { try {
    const response = await list.request("/console/api/v1/feedback"); if (response === null) return;
    list.show(() => [toolbar(search), table(rows(response.feedback), [
      { key: "id", label: "ID" }, { key: "diagnosticNumber", label: "诊断编号" },
      { key: "incident", label: "分类", format: (value) => translated(object(value).category) },
      { key: "occurredAt", label: "发生时间" },
      { key: "application", label: "软件版本", format: (value) => String(object(value).version ?? "—") },
      { key: "application", label: "Build", format: (value) => String(object(value).build ?? "—") },
      { key: "system", label: "平台", format: (value) => platformName(object(value).platform) },
      { key: "system", label: "系统版本", format: (value) => String(object(value).version ?? "—") },
    ], (row) => [button("详情", (origin) => showDetail(String(row.id), origin))])]);
  } catch { list.error(); } };
  search.addEventListener("submit", (event) => { event.preventDefault(); list.reset(); void load(); }); await load();
}
