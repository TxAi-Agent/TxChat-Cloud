import { listWorkspace, detailDrawer, createDraftDrawer, translated } from "./listWorkspace.js";
import { AdminApiError } from "../api.js";
import { button, detailList, durationText, failed, field, formValue, object, rows, section, table, toolbar, type PageContext } from "./shared.js";

function priceText(value: unknown): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return "—";
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`;
}

export async function renderOffersPage(context: PageContext): Promise<void> {
  const draftForm = document.createElement("form"); draftForm.className = "tx-inline-form";
  // Keep validation in this form so all invalid fields are explained together.
  draftForm.noValidate = true;
  const nameField = field("产品名称（必填）", "displayName");
  const nameInput = nameField.querySelector("input")!;
  nameInput.required = true; nameInput.maxLength = 80; nameInput.placeholder = "请输入产品名称";
  const durationField = field("包含时长（分钟，必填）", "includedMinutes", "number");
  const durationInput = durationField.querySelector("input")!;
  durationInput.required = true; durationInput.min = "1"; durationInput.max = "60000000";
  durationInput.step = "1"; durationInput.inputMode = "numeric"; durationInput.placeholder = "例如 600";
  const amountField = field("价格（元，必填）", "amountYuan", "number");
  const timeField = field("生效时间（北京时间，必填）", "effectiveAt", "datetime-local");
  const amountInput = amountField.querySelector("input")!;
  const timeInput = timeField.querySelector("input")!;
  amountInput.required = true; amountInput.min = "0.01"; amountInput.max = "1000000"; amountInput.step = "0.01";
  amountInput.inputMode = "decimal"; amountInput.placeholder = "例如 17.99";
  timeInput.required = true; timeInput.step = "1";

  const timeHint = document.createElement("small"); timeHint.id = "offer-effective-hint";
  timeHint.textContent = "按北京时间填写，精确到秒。";
  timeField.append(timeHint);
  const fieldError = (wrapper: HTMLElement, id: string) => {
    const message = document.createElement("small"); message.id = id; message.className = "tx-offer-error";
    message.setAttribute("role", "alert"); message.hidden = true; wrapper.append(message); return message;
  };
  const durationError = fieldError(durationField, "offer-duration-error");
  durationInput.setAttribute("aria-describedby", durationError.id);
  const nameError = fieldError(nameField, "offer-name-error");
  nameInput.setAttribute("aria-describedby", nameError.id);
  const amountError = fieldError(amountField, "offer-amount-error");
  const timeError = fieldError(timeField, "offer-effective-error");
  amountInput.setAttribute("aria-describedby", amountError.id);
  timeInput.setAttribute("aria-describedby", `${timeHint.id} ${timeError.id}`);
  const setFieldError = (input: HTMLInputElement, message: HTMLElement, text: string) => {
    message.textContent = text; message.hidden = text === "";
    input.setAttribute("aria-invalid", String(text !== ""));
  };
  const remarkField = field("备注（选填）", "remark");
  const remarkInput = document.createElement("textarea"); remarkInput.name = "remark";
  remarkInput.className = "form-control"; remarkInput.rows = 4; remarkInput.maxLength = 500;
  remarkInput.placeholder = "填写套餐说明，最多 500 字";
  remarkField.querySelector("input")!.replaceWith(remarkInput);
  draftForm.append(nameField, amountField, durationField, timeField, remarkField);
  const create = document.createElement("button"); create.type = "submit"; create.className = "tx-button tx-button-primary"; create.textContent = "创建套餐"; draftForm.append(create);
  const createError = document.createElement("p"); createError.className = "tx-offer-error tx-offer-submit-error";
  createError.setAttribute("role", "alert"); createError.hidden = true; draftForm.append(createError);
  const draft = createDraftDrawer(context, "新建套餐", draftForm, create);
  const search = document.createElement("form"); search.className = "tx-inline-form"; search.append(field("ID", "idPrefix"));
  const submit = document.createElement("button"); submit.type = "submit"; submit.className = "tx-button tx-button-primary"; submit.textContent = "查询"; search.append(submit);
  const list = listWorkspace(context, search, () => load(), { keyword: "产品名称", states: ["draft", "scheduled", "active", "retired"] });
  const showDetail = (id: string, origin: HTMLButtonElement) => detailDrawer(context, origin, "套餐详情", async () => {
    const response = object(await context.api.request(`/console/api/v1/offers/${id}`)); const offer = object(response.offer);
    return [
      section("套餐信息", detailList([
        { label: "ID", value: offer.id },
        { label: "产品名称", value: offer.displayName },
        { label: "价格（元）", value: priceText(offer.amountFen) },
        { label: "包含时长", value: durationText(offer.includedDurationMs) },
        { label: "状态", value: translated(offer.state) },
        { label: "生效时间", value: offer.effectiveAt }, { label: "失效时间", value: offer.retiredAt },
        { label: "备注", value: offer.remark || "—" },
        { label: "创建时间", value: offer.createdAt }, { label: "发布时间", value: offer.publishedAt },
      ])),
    ];
  });
  const load = async (): Promise<void> => { try {
    const response = await list.request("/console/api/v1/offers"); if (response === null) return; const catalog = object(response.catalog);
    if (catalog.salesState !== "active" && catalog.salesState !== "paused") throw new Error("Invalid sales state");
    list.show(() => {
    const selling = catalog.salesState === "active";
    const label = selling ? "暂停销售" : "恢复销售";
    const toggle = button(label, async () => {
      if (!window.confirm(`确认${label}？`)) return;
      try {
        await context.api.request(`/console/api/v1/offers/sales/${selling ? "pause" : "resume"}`, { method: "POST" });
      } catch {
        if (context.isCurrent?.() !== false) window.alert("未能确认操作结果，列表将刷新，请根据最新状态确认后再操作。");
      }
      if (context.isCurrent?.() !== false) await load();
    }, selling ? "warning" : "secondary");
    const actions = document.createElement("div"); actions.className = "tx-offers-toolbar-actions";
    actions.append(draft.trigger, toggle);
    const controls = toolbar(search, actions); controls.classList.add("tx-offers-toolbar");
    return [controls, table(rows(response.offers), [
      { key: "id", label: "ID" }, { key: "displayName", label: "产品名称" }, { key: "state", label: "状态", format: translated },
      { key: "amountFen", label: "价格（元）", format: priceText }, { key: "effectiveAt", label: "生效时间" },
    ], (row) => [button("详情", (origin) => showDetail(String(row.id), origin)), ...(row.state === "draft" ? [
      button("发布", async () => {
        if (!window.confirm(`确认发布套餐 ${String(row.id)}？`)) return;
        await context.api.request(`/console/api/v1/offers/${String(row.id)}/publish`, { method: "POST", body: { expectedRevision: row.revision } }); await load();
      }),
    ] : []), ...(row.state === "scheduled" ? [
      button("撤回发布", async () => {
        if (!window.confirm("确认撤回该套餐的发布？撤回后回到待发布状态，当前生效套餐不受影响。")) return;
        try {
          await context.api.request(`/console/api/v1/offers/${String(row.id)}/withdraw`, {
            method: "POST", body: { expectedRevision: row.revision },
          });
          if (context.isCurrent?.() !== false) await load();
        } catch (error) {
          if (context.isCurrent?.() === false) return;
          if (error instanceof AdminApiError && error.code === "ADMIN_OFFER_IMMUTABLE") {
            window.alert("该套餐已生效或已不处于待生效状态，无法撤回。列表将刷新。");
          } else if (error instanceof AdminApiError && error.code === "ADMIN_REVISION_CONFLICT") {
            window.alert("套餐状态已发生变化，请根据刷新后的状态重新操作。");
          } else {
            window.alert("未能确认撤回结果，请根据刷新后的状态确认后再操作。");
          }
          await load();
        }
      }, "warning"),
    ] : [])])];
    });
  } catch { list.error(); } };
  draftForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (create.disabled || context.isCurrent?.() === false) return;
    createError.hidden = true; createError.textContent = "";
    const displayName = formValue(draftForm, "displayName");
    const nameMessage = displayName === "" ? "请输入产品名称。"
      : displayName.length > 80 || /[\u0000-\u001f\u007f]/u.test(displayName) ? "产品名称须为 1–80 字，不能包含控制字符。" : "";
    setFieldError(nameInput, nameError, nameMessage);
    if (nameMessage !== "") { nameInput.focus(); return; }
    const minutesText = formValue(draftForm, "includedMinutes");
    const includedMinutes = /^\d{1,8}$/u.test(minutesText) ? Number(minutesText) : NaN;
    // The form uses whole minutes; convert once at the existing API boundary.
    const includedDurationMs = includedMinutes * 60_000;
    const durationMessage = minutesText === "" ? "请输入包含时长（分钟）。"
      : !Number.isSafeInteger(includedMinutes) || includedMinutes < 1 || includedMinutes > 60_000_000
        ? "包含时长须为 1 至 60000000 分钟的正整数，不支持小数。" : "";
    setFieldError(durationInput, durationError, durationMessage);
    if (durationMessage !== "") { durationInput.focus(); return; }
    const remark = formValue(draftForm, "remark");
    if (remark.length > 500) { createError.textContent = "备注最多填写 500 字。"; createError.hidden = false; remarkInput.focus(); return; }
    const amountText = formValue(draftForm, "amountYuan");
    // Convert decimal digits to integer fen without floating-point multiplication.
    const priceParts = /^(\d{1,7})(?:\.(\d{1,2}))?$/u.exec(amountText);
    const amountFen = priceParts === null ? NaN
      : Number(priceParts[1]) * 100 + Number((priceParts[2] ?? "").padEnd(2, "0"));
    const localTime = formValue(draftForm, "effectiveAt");
    const parsedTime = new Date(`${localTime}+08:00`);
    const effectiveAt = Number.isFinite(parsedTime.getTime()) ? parsedTime.toISOString() : "";
    const amountMessage = amountText === "" ? "请输入价格（元）。"
      : !Number.isSafeInteger(amountFen) || amountFen < 1 || amountFen > 100_000_000
        ? "价格须为 0.01 至 1000000 元，最多保留两位小数。" : "";
    const timeMessage = localTime === "" ? "请输入生效时间。"
      : !Number.isFinite(parsedTime.getTime()) || parsedTime.getUTCFullYear() < 2000 || parsedTime.getUTCFullYear() > 9999
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/u.test(localTime)
        || new Date(parsedTime.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 19) !== (localTime.length === 16 ? `${localTime}:00` : localTime)
        ? "请输入有效的生效时间（北京时间，年份 2000–9999）。" : "";
    setFieldError(amountInput, amountError, amountMessage); setFieldError(timeInput, timeError, timeMessage);
    if (amountMessage !== "" || timeMessage !== "") {
      (amountMessage !== "" ? amountInput : timeInput).focus(); return;
    }
    draft.setBusy(true); create.disabled = true; create.textContent = "创建中…";
    amountInput.disabled = true; timeInput.disabled = true;
    void (async () => {
    await context.api.request("/console/api/v1/offers", { method: "POST", body: {
      productCode: "txchat-monthly-cloud-10h", displayName, productType: "membership",
      tierCode: "standard", currency: "CNY", amountFen,
      quotaAmount: includedDurationMs, quotaUnit: "milliseconds", includedDurationMs,
      periodUnit: "calendar_month", periodCount: 1, timezone: "Asia/Shanghai", rollover: false,
      autoRenew: false, activeMemberRepurchase: false, effectiveAt, remark,
    } }); draftForm.reset(); draft.close(); if (context.isCurrent?.() !== false) await load();
    })().catch((error: unknown) => {
      createError.textContent = error instanceof AdminApiError && error.status === 400
        ? "套餐未创建，请检查产品名称、包含时长、价格和生效时间。已保留填写内容。"
        : error instanceof AdminApiError && (error.status === 401 || error.status === 403)
          ? "登录状态或操作权限已失效，请刷新页面或重新登录后再试。已保留填写内容。"
          : "未能确认创建结果，已保留填写内容。请先查询套餐列表，确认未创建后再重试。";
      createError.hidden = false;
    }).finally(() => {
      draft.setBusy(false); create.disabled = false; create.textContent = "创建套餐";
      amountInput.disabled = false; timeInput.disabled = false;
    });
  });
  search.addEventListener("submit", (event) => { event.preventDefault(); list.reset(); void load(); }); await load();
}
