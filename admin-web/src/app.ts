import { AdminApiClient, AdminApiError } from "./api.js";
import {
  configureNavigation,
  type AdminMenuCode,
  menuLabel,
} from "./navigation.js";
import { showTableState } from "./tables.js";
import { renderAccountsPage } from "./pages/accounts.js";
import { renderFeedbackPage } from "./pages/feedback.js";
import { renderModelsPage } from "./pages/models.js";
import { renderOffersPage } from "./pages/offers.js";
import { renderOrdersPage } from "./pages/orders.js";
import { renderSmsPage } from "./pages/sms.js";
import { renderUsersPage } from "./pages/users.js";
import type { PageContext, PageFilters } from "./pages/shared.js";
import {
  adminSetupFailurePolicy,
  AdminSetupSubmissionGuard,
  parseAdminSetupFragment,
  type AdminSetupFragment,
} from "./setup.js";

let pendingSetup: AdminSetupFragment | undefined =
  parseAdminSetupFragment(window.location.hash) ?? undefined;
if (window.location.hash !== "") {
  history.replaceState(null, "", "/console/");
}

type SessionResponse = Readonly<{
  account: Readonly<{
    username: string;
    kind: "super_admin" | "administrator";
  }>;
  menus: readonly AdminMenuCode[];
  csrfToken?: string;
}>;

const api = new AdminApiClient();
const setupSubmissionGuard = new AdminSetupSubmissionGuard();

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) {
    throw new Error("Required administrator shell element is unavailable");
  }
  return element as T;
}

function hideSetupForms(): void {
  required("admin-setup").hidden = true;
  required("admin-reset").hidden = true;
}

function showLogin(message?: string, notice?: string): void {
  api.clear();
  hideSetupForms();
  required("admin-application").hidden = true;
  required("admin-login").hidden = false;
  const error = required("admin-login-error");
  error.hidden = message === undefined;
  error.textContent = message ?? "";
  const success = required("admin-login-notice");
  success.hidden = notice === undefined;
  success.textContent = notice ?? "";
}

function showSetup(mode: AdminSetupFragment["mode"]): void {
  api.clear();
  required("admin-login").hidden = true;
  required("admin-application").hidden = true;
  required("admin-setup").hidden = mode !== "setup";
  required("admin-reset").hidden = mode !== "reset";
}

function clearSetupPasswords(): void {
  for (const id of [
    "admin-setup-password",
    "admin-setup-password-confirmation",
    "admin-reset-password",
    "admin-reset-password-confirmation",
  ]) {
    required<HTMLInputElement>(id).value = "";
  }
}

function showSetupError(mode: AdminSetupFragment["mode"], message: string): void {
  const error = required(`admin-${mode}-error`);
  error.hidden = false;
  error.textContent = message;
}

let menuVersion = 0;
let pendingNavigation: { menu: AdminMenuCode; filters: PageFilters } | undefined;
let signedInAccountKind: SessionResponse["account"]["kind"] | undefined;

function selectMenu(menu: AdminMenuCode, label = menuLabel(menu)): void {
  const version = ++menuVersion;
  const filters = pendingNavigation?.menu === menu ? pendingNavigation.filters : undefined;
  pendingNavigation = undefined;
  delete required("admin-content").dataset.userView;
  delete required("admin-content").dataset.listView;
  required("admin-page-title").textContent = label;
  required("admin-content").replaceChildren();
  showTableState("loading");
  const pages: Readonly<Record<AdminMenuCode, (context: PageContext) => Promise<void>>> = {
    "users.list": renderUsersPage,
    "feedback.list": renderFeedbackPage,
    "offers.list": renderOffersPage,
    "orders.list": renderOrdersPage,
    "models.config": renderModelsPage,
    "sms.config": renderSmsPage,
    "accounts.list": renderAccountsPage,
  };
  void pages[menu]({
    api,
    root: required("admin-content"),
    ...(signedInAccountKind === undefined ? {} : { accountKind: signedInAccountKind }),
    isCurrent: () => version === menuVersion,
    ...(filters === undefined ? {} : { initialFilters: filters }),
    canNavigate: (target) => {
      const control = required("admin-navigation").querySelector(`[data-menu-code="${target}"]`);
      return control instanceof HTMLButtonElement && !control.hidden;
    },
    navigate: (target, nextFilters) => {
      const control = required("admin-navigation")
        .querySelector(`[data-menu-code="${target}"]`);
      if (control instanceof HTMLButtonElement && !control.hidden) {
        pendingNavigation = nextFilters === undefined ? undefined : { menu: target, filters: nextFilters };
        control.click();
      }
    },
  });
  window.dispatchEvent(new CustomEvent("txchat:menu", { detail: { menu } }));
}

function showApplication(session: SessionResponse): void {
  hideSetupForms();
  if (session.csrfToken !== undefined) api.setCsrfToken(session.csrfToken);
  required("admin-login").hidden = true;
  required("admin-application").hidden = false;
  signedInAccountKind = session.account.kind;
  required("admin-account-name").textContent = session.account.username;
  required("admin-account-kind").textContent = session.account.kind === "super_admin"
    ? "超级管理员"
    : "管理员";
  const first = configureNavigation(
    required("admin-navigation"),
    session.menus,
    selectMenu,
  );
  if (first === null) {
    showTableState("empty");
    required("admin-page-title").textContent = "暂无可访问菜单";
  } else {
    selectMenu(first);
  }
}

async function consumeSetup(mode: AdminSetupFragment["mode"]): Promise<void> {
  const active = pendingSetup;
  if (active === undefined || active.mode !== mode) {
    showSetupError(mode, "设置链接无效或已过期。");
    clearSetupPasswords();
    pendingSetup = undefined;
    return;
  }
  const password = required<HTMLInputElement>(`admin-${mode}-password`);
  const confirmation = required<HTMLInputElement>(
    `admin-${mode}-password-confirmation`,
  );
  if (password.value !== confirmation.value) {
    showSetupError(mode, "两次输入的密码不一致。");
    clearSetupPasswords();
    return;
  }
  const error = required(`admin-${mode}-error`);
  error.hidden = true;
  error.textContent = "";
  let succeeded = false;
  try {
    if (mode === "setup") {
      await api.consumeSetup({
        token: active.token,
        username: required<HTMLInputElement>("admin-setup-username").value,
        password: password.value,
      });
    } else {
      await api.consumeReset({ token: active.token, password: password.value });
    }
    succeeded = true;
  } catch (failure) {
    const policy = adminSetupFailurePolicy(
      failure instanceof AdminApiError ? failure.status : 503,
    );
    showSetupError(
      mode,
      policy.message,
    );
  } finally {
    pendingSetup = undefined;
    clearSetupPasswords();
  }
  if (succeeded) {
    required<HTMLInputElement>("admin-setup-username").value = "";
    showLogin(undefined, "密码已设置，请使用新密码登录。");
  }
}

async function bootstrap(): Promise<void> {
  try {
    const session = await api.request<SessionResponse>("/console/api/v1/session");
    await api.request<void>("/console/api/v1/session/csrf", { method: "POST" });
    showApplication(session);
  } catch (error) {
    if (error instanceof AdminApiError && error.code === "ADMIN_AUTH_REQUIRED") {
      showLogin();
      return;
    }
    showLogin("服务暂时不可用，请稍后重试。");
  }
}

function installShellEvents(): void {
  required<HTMLFormElement>("admin-setup-form").addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      void setupSubmissionGuard.run(
        required<HTMLButtonElement>("admin-setup-submit"),
        () => consumeSetup("setup"),
      );
    },
  );
  required<HTMLFormElement>("admin-reset-form").addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      void setupSubmissionGuard.run(
        required<HTMLButtonElement>("admin-reset-submit"),
        () => consumeSetup("reset"),
      );
    },
  );

  const loginForm = required<HTMLFormElement>("admin-login-form");
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const username = required<HTMLInputElement>("admin-username");
    const password = required<HTMLInputElement>("admin-password");
    try {
      showApplication(await api.request<SessionResponse>("/console/api/v1/session/login", {
        method: "POST",
        body: { username: username.value, password: password.value },
      }));
    } catch (error) {
      showLogin(error instanceof AdminApiError && error.code === "ADMIN_RATE_LIMITED"
        ? "登录尝试过于频繁，请稍后重试。"
        : "账户或密码错误。");
    } finally {
      password.value = "";
    }
  });

  required<HTMLButtonElement>("admin-logout").addEventListener("click", async () => {
    try {
      await api.request<void>("/console/api/v1/session/logout", { method: "POST" });
    } finally {
      showLogin();
    }
  });

  const sidebar = required("admin-sidebar");
  const desktopToggle = required<HTMLButtonElement>("admin-sidebar-toggle");
  desktopToggle.addEventListener("click", () => {
    const collapsed = sidebar.classList.toggle("tx-sidebar-collapsed");
    desktopToggle.setAttribute("aria-expanded", String(!collapsed));
  });
  const narrowToggle = required<HTMLButtonElement>("admin-narrow-toggle");
  narrowToggle.addEventListener("click", () => {
    const open = sidebar.classList.toggle("tx-sidebar-open");
    narrowToggle.setAttribute("aria-expanded", String(open));
  });
}

document.addEventListener("DOMContentLoaded", () => {
  installShellEvents();
  if (pendingSetup === undefined) {
    void bootstrap();
  } else {
    showSetup(pendingSetup.mode);
  }
});
