export type AdminMenuCode =
  | "users.list"
  | "feedback.list"
  | "offers.list"
  | "orders.list"
  | "models.config"
  | "sms.config"
  | "accounts.list";

export const MENU_ORDER = Object.freeze([
  "users.list",
  "feedback.list",
  "offers.list",
  "orders.list",
  "models.config",
  "sms.config",
  "accounts.list",
] as const);

const MENU_LABELS: Readonly<Record<AdminMenuCode, string>> = Object.freeze({
  "users.list": "用户列表",
  "feedback.list": "反馈列表",
  "offers.list": "套餐列表",
  "orders.list": "订单列表",
  "models.config": "模型配置",
  "sms.config": "短信服务配置",
  "accounts.list": "账户列表",
});

function menuButton(value: Element): value is HTMLButtonElement {
  return value instanceof HTMLButtonElement &&
    value.dataset.menuCode !== undefined;
}

export function configureNavigation(
  container: HTMLElement,
  permissions: readonly AdminMenuCode[],
  onNavigate: (menu: AdminMenuCode, label: string) => void,
): AdminMenuCode | null {
  const allowed = new Set<AdminMenuCode>(permissions);
  const buttons = [...container.querySelectorAll("[data-menu-code]")]
    .filter(menuButton);
  for (const button of buttons) {
    const menu = button.dataset.menuCode as AdminMenuCode;
    const visible = allowed.has(menu) && MENU_ORDER.includes(menu);
    button.hidden = !visible;
    button.tabIndex = visible ? 0 : -1;
    button.addEventListener("click", () => {
      if (!visible) return;
      for (const item of buttons) item.removeAttribute("aria-current");
      button.setAttribute("aria-current", "page");
      onNavigate(menu, MENU_LABELS[menu]);
    });
  }
  for (const group of container.querySelectorAll<HTMLElement>("[data-menu-group]")) {
    group.hidden = ![...group.querySelectorAll("[data-menu-code]")]
      .some((item) => item instanceof HTMLButtonElement && !item.hidden);
  }
  const first = MENU_ORDER.find((menu) => allowed.has(menu)) ?? null;
  if (first !== null) {
    const button = buttons.find(({ dataset }) => dataset.menuCode === first);
    button?.setAttribute("aria-current", "page");
  }
  return first;
}

export function menuLabel(menu: AdminMenuCode): string {
  return MENU_LABELS[menu];
}
