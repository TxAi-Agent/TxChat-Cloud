import { listWorkspace, detailDrawer, translated } from "./listWorkspace.js";
import { button, detailList, durationText, failed, field, formValue, object, rows, section, table, toolbar, type PageContext } from "./shared.js";

function amountYuan(value: unknown): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return "—";
  return (value / 100).toFixed(2);
}

export async function renderOrdersPage(context: PageContext): Promise<void> {
  const search = document.createElement("form"); search.className = "tx-inline-form"; search.append(field("ID", "idPrefix"), field("用户 ID", "userId"));
  const userFilter = search.querySelector<HTMLInputElement>('input[name="userId"]');
  if (userFilter) { userFilter.value = context.initialFilters?.userId ?? ""; userFilter.maxLength = 32; }
  const submit = document.createElement("button"); submit.type = "submit"; submit.className = "tx-button tx-button-primary"; submit.textContent = "查询"; search.append(submit);
  const list = listWorkspace(context, search, () => load(), { keyword: "商户订单号", states: ["pending", "paid", "expired", "refunded", "payment_exception"] });
  const showDetail = (id: string, origin: HTMLButtonElement) => detailDrawer(context, origin, "订单详情", async () => {
    const response = object(await context.api.request(`/console/api/v1/orders/${id}`));
    const order = object(response.order); const user = object(order.user);
    const offer = object(order.offerSnapshot); const wechat = object(order.wechat);
    return [
      section("订单详情", detailList([
        { label: "ID", value: order.id }, { label: "用户 ID", value: user.id },
        { label: "手机号", value: typeof user.phone === "string" ? user.phone.replace(/^\+86(?=1[3-9][0-9]{9}$)/u, "") : "—" }, { label: "状态", value: translated(order.status) },
        { label: "金额（元）", value: amountYuan(order.amountFen) },
        { label: "商户订单号", value: wechat.outTradeNo }, { label: "微信交易号", value: wechat.transactionId },
        { label: "创建时间", value: order.createdAt }, { label: "过期时间", value: order.expiresAt },
        { label: "支付时间", value: order.paidAt }, { label: "退款时间", value: order.refundedAt },
      ])),
      section("套餐快照", detailList([
        { label: "Offer ID", value: offer.versionId }, { label: "产品 ID", value: offer.productId },
        { label: "产品编码", value: offer.productCode }, { label: "套餐", value: offer.displayName },
        { label: "类型与档位", value: `${translated(offer.productType)} / ${translated(offer.tierCode)}` },
        { label: "套餐金额（元）", value: amountYuan(offer.amountFen) },
        { label: "包含额度", value: durationText(offer.includedDurationMs) },
        { label: "周期", value: `${translated(offer.periodUnit)} × ${String(offer.periodCount ?? "—")} / ${String(offer.timezone ?? "—")}` },
        { label: "策略", value: `rollover=${String(offer.rollover ?? "—")}, autoRenew=${String(offer.autoRenew ?? "—")}, repurchase=${String(offer.activeMemberRepurchase ?? "—")}` },
      ])),
      section("支付通知", table(rows(order.callbacks), [
        { key: "id", label: "ID" }, { key: "externalNotificationId", label: "通知号" },
        { key: "transactionId", label: "微信交易号" }, { key: "result", label: "结果" },
        { key: "duplicate", label: "重复通知" }, { key: "receivedAt", label: "接收时间" },
        { key: "processedAt", label: "处理时间" },
      ])),
      section("对账记录", table(rows(order.reconciliations), [
        { key: "id", label: "ID" }, { key: "category", label: "分类" },
        { key: "result", label: "结果" }, { key: "actorUsername", label: "操作人" },
        { key: "occurredAt", label: "时间" },
      ])),
      section("外部人工退款记录", table(rows(order.refunds), [
        { key: "id", label: "ID" }, { key: "amountFen", label: "金额（元）", format: amountYuan },
        { key: "wechatRefundId", label: "微信退款号" }, { key: "status", label: "状态", format: translated },
        { key: "operatorNote", label: "记录说明" }, { key: "recordedByUsername", label: "记录人" },
        { key: "createdAt", label: "创建时间" }, { key: "confirmedAt", label: "确认时间" },
      ])),
    ];
  });
  const load = async (): Promise<void> => { try {
    const response = await list.request("/console/api/v1/orders"); if (response === null) return;
    list.show(() => [toolbar(search), table(rows(response.orders), [
      { key: "id", label: "ID" }, { key: "user", label: "用户 ID", format: (value) => String(object(value).id ?? "—") },
      { key: "user", label: "手机号", format: (value) => String(object(value).phone ?? "—").replace(/^\+86(?=1[3-9][0-9]{9}$)/u, "") },
      { key: "offerSnapshot", label: "套餐快照", format: (value) => String(object(value).displayName ?? "—") },
      { key: "status", label: "状态", format: translated }, { key: "amountFen", label: "金额（元）", format: amountYuan },
      { key: "createdAt", label: "创建时间" },
    ], (row) => [button("详情", (origin) => showDetail(String(row.id), origin))])]);
  } catch { list.error(); } };
  search.addEventListener("submit", (event) => { event.preventDefault(); list.reset(); void load(); }); await load();
}
