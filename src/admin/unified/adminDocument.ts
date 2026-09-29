const DOCUMENT = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>TxChat 管理后台</title>
  <link rel="icon" href="data:,">
  <link rel="stylesheet" href="/console/assets/tabler.min.css">
  <link rel="stylesheet" href="/console/assets/tabler-icons.min.css">
  <link rel="stylesheet" href="/console/assets/txchat-admin.css">
</head>
<body class="tx-admin-body">
  <main id="admin-login" class="tx-login" aria-labelledby="admin-login-title">
    <section class="tx-login-card">
      <div class="tx-brand-mark" aria-hidden="true">Tx</div>
      <p class="tx-eyebrow">TXCHAT CLOUD</p>
      <h1 id="admin-login-title">管理后台登录</h1>
      <p class="tx-muted">使用管理员账号继续。</p>
      <p id="admin-login-notice" class="tx-form-success" role="status" hidden></p>
      <form id="admin-login-form" novalidate>
        <label class="form-label" for="admin-username">账号</label>
        <input id="admin-username" class="form-control" name="username" autocomplete="username" required maxlength="64">
        <label class="form-label mt-3" for="admin-password">密码</label>
        <input id="admin-password" class="form-control" name="password" type="password" autocomplete="current-password" required maxlength="128">
        <p id="admin-login-error" class="tx-form-error" role="alert" hidden></p>
        <button class="btn tx-primary-button w-100 mt-4" type="submit">登录</button>
      </form>
    </section>
  </main>

  <main id="admin-setup" class="tx-login" aria-labelledby="admin-setup-title" hidden>
    <section class="tx-login-card">
      <div class="tx-brand-mark" aria-hidden="true">Tx</div>
      <p class="tx-eyebrow">TXCHAT CLOUD</p>
      <h1 id="admin-setup-title">设置管理员账号</h1>
      <p class="tx-muted">设置账号和密码后，请使用新账号登录。</p>
      <form id="admin-setup-form" novalidate>
        <label class="form-label" for="admin-setup-username">账号</label>
        <input id="admin-setup-username" class="form-control" name="username" autocomplete="username" required maxlength="64">
        <label class="form-label mt-3" for="admin-setup-password">密码</label>
        <input id="admin-setup-password" class="form-control" name="password" type="password" autocomplete="new-password" required minlength="8" maxlength="128">
        <label class="form-label mt-3" for="admin-setup-password-confirmation">确认密码</label>
        <input id="admin-setup-password-confirmation" class="form-control" name="passwordConfirmation" type="password" autocomplete="new-password" required minlength="8" maxlength="128">
        <p id="admin-setup-error" class="tx-form-error" role="alert" hidden></p>
        <button id="admin-setup-submit" class="btn tx-primary-button w-100 mt-4" type="submit">完成设置</button>
      </form>
    </section>
  </main>

  <main id="admin-reset" class="tx-login" aria-labelledby="admin-reset-title" hidden>
    <section class="tx-login-card">
      <div class="tx-brand-mark" aria-hidden="true">Tx</div>
      <p class="tx-eyebrow">TXCHAT CLOUD</p>
      <h1 id="admin-reset-title">重置管理员密码</h1>
      <p class="tx-muted">设置新密码后，所有旧会话将失效。</p>
      <form id="admin-reset-form" novalidate>
        <label class="form-label" for="admin-reset-password">新密码</label>
        <input id="admin-reset-password" class="form-control" name="password" type="password" autocomplete="new-password" required minlength="8" maxlength="128">
        <label class="form-label mt-3" for="admin-reset-password-confirmation">确认新密码</label>
        <input id="admin-reset-password-confirmation" class="form-control" name="passwordConfirmation" type="password" autocomplete="new-password" required minlength="8" maxlength="128">
        <p id="admin-reset-error" class="tx-form-error" role="alert" hidden></p>
        <button id="admin-reset-submit" class="btn tx-primary-button w-100 mt-4" type="submit">完成重置</button>
      </form>
    </section>
  </main>

  <div id="admin-application" class="tx-app" hidden>
    <aside id="admin-sidebar" class="tx-sidebar" aria-label="管理后台导航">
      <header class="tx-sidebar-header">
        <div class="tx-brand-mark tx-brand-mark-small" aria-hidden="true">Tx</div>
        <div>
          <strong>TxChat</strong>
          <span>Cloud 管理后台</span>
        </div>
        <button id="admin-sidebar-toggle" class="tx-icon-button" type="button" aria-label="收起或展开导航" aria-controls="admin-navigation" aria-expanded="true">
          <i class="ti ti-layout-sidebar-left-collapse" aria-hidden="true"></i>
        </button>
      </header>
      <nav id="admin-navigation">
        <section class="tx-nav-group" data-menu-group>
          <h2 data-menu-label>用户管理</h2>
          <button type="button" data-menu-code="users.list" data-menu-label>用户列表</button>
        </section>
        <section class="tx-nav-group" data-menu-group>
          <h2 data-menu-label>反馈管理</h2>
          <button type="button" data-menu-code="feedback.list" data-menu-label>反馈列表</button>
        </section>
        <section class="tx-nav-group" data-menu-group>
          <h2 data-menu-label>套餐管理</h2>
          <button type="button" data-menu-code="offers.list" data-menu-label>套餐列表</button>
        </section>
        <section class="tx-nav-group" data-menu-group>
          <h2 data-menu-label>订单管理</h2>
          <button type="button" data-menu-code="orders.list" data-menu-label>订单列表</button>
        </section>
        <section class="tx-nav-group" data-menu-group>
          <h2 data-menu-label>系统管理</h2>
          <button type="button" data-menu-code="models.config" data-menu-label>模型配置</button>
          <button type="button" data-menu-code="sms.config" data-menu-label>短信服务配置</button>
        </section>
        <section class="tx-nav-group" data-menu-group>
          <h2 data-menu-label>账户管理</h2>
          <button type="button" data-menu-code="accounts.list" data-menu-label>账户列表</button>
        </section>
      </nav>
      <footer class="tx-sidebar-footer">
        <div>
          <strong id="admin-account-name"></strong>
          <span id="admin-account-kind"></span>
        </div>
        <button id="admin-logout" class="tx-text-button" type="button">退出</button>
      </footer>
    </aside>

    <main class="tx-main">
      <header class="tx-page-header">
        <div>
          <p class="tx-eyebrow">TXCHAT CLOUD</p>
          <h1 id="admin-page-title">管理后台</h1>
        </div>
        <button id="admin-narrow-toggle" class="tx-icon-button tx-narrow-toggle" type="button" aria-label="打开导航" aria-controls="admin-sidebar" aria-expanded="false">
          <i class="ti ti-menu-2" aria-hidden="true"></i>
        </button>
      </header>
      <section id="admin-loading" class="tx-state" aria-live="polite" hidden>
        <span class="spinner-border spinner-border-sm" aria-hidden="true"></span>
        <p>正在加载</p>
      </section>
      <section id="admin-error" class="tx-state tx-state-error" role="alert" hidden>
        <i class="ti ti-alert-circle" aria-hidden="true"></i>
        <p>加载失败，请稍后重试。</p>
      </section>
      <section id="admin-empty" class="tx-state" hidden>
        <i class="ti ti-inbox" aria-hidden="true"></i>
        <p>暂无数据</p>
      </section>
      <section id="admin-content" class="tx-content" aria-live="polite"></section>
    </main>
  </div>
  <script type="module" src="/console/assets/modules/app.js"></script>
</body>
</html>
`;

export function renderAdminDocument(): string {
  return DOCUMENT;
}
