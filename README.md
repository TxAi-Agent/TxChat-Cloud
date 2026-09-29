# TxChat Cloud

[简体中文](README.zh-CN.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

TxChat Cloud is a TypeScript service for developers building an account-based speech-to-text application. It includes SMS sign-in and sessions, recorded and streaming dictation, text rewriting, membership and usage accounting, payment order handling, diagnostic submissions, and a browser administrator console.

The repository contains business implementations and configurable integrations with external services. An unconfigured SMS, speech/model, or payment integration stays unavailable: the server does not substitute successful mock responses. Automated tests use isolated test doubles.

## Who this is for

Developers can use the service as a backend foundation, adapt its provider interfaces, or connect an application to its HTTP and WebSocket APIs. You need your own external service accounts and configuration to exercise the full sign-in, recognition, and payment flows. This repository does not include hosted service access or credentials.

## Local development

Use Node.js 24 and pnpm 11.19.0. The SQLite binding is a native dependency; environments without a compatible prebuilt binary require their platform's native build toolchain.

```sh
npm install --global pnpm@11.19.0
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm dev
```

`pnpm verify` runs type checking, the server/admin build, and tests. The commands above describe the workflow; successful installation or a listening server does not verify any external service integration.

The default API listener is `localhost:3000`; the administrator listener is `localhost:3001`. Open the administrator console using `http://localhost:3001/console/`, which matches the default administrator origin. The two listeners have separate responsibilities.

On a fresh start, the service creates its business schema without adding sample users, products, or external provider configuration. Billing entitlement checks remain enforced.

The service uses `.local-data/` by default for its SQLite databases, private application keys, and temporary audio. A fresh data directory gets independent application keys. Keep those keys together with data that depends on them; reusing a database with lost or replacement keys cannot recover encrypted content. Do not commit the data directory.

On first startup, the service creates `.local-data/administrator-setup.json` with a short-lived setup URL. Read that file locally and open the URL to create the initial administrator. The link expires after ten minutes. Restarting before an administrator exists issues a new setup link; after account creation a subsequent initialization removes the file. Treat the URL as a secret.

The server reads environment variables. `pnpm dev` does not automatically load a `.env` file. To load one explicitly after building, use:

```sh
node --env-file=.env dist/server.js
```

## Configuration

See [the configuration schema](src/config.ts) for validation and defaults. Configure an integration as a complete group; partial credentials or invalid values are rejected. Secret values are read from local files, not copied into source code.

| Purpose | Variables | Default or behavior |
| --- | --- | --- |
| Application | `APP_ENV` | `development`; also accepts `test` and `production` |
| Data and encryption | `COMMUNITY_DATA_DIRECTORY`, `COMMUNITY_KEYS_FILE` | `.local-data/`; independent keys are generated only for new data when no explicit key file is supplied |
| API listener | `COMMUNITY_HOST`, `COMMUNITY_PORT` | `localhost`, `3000` |
| Administrator listener | `COMMUNITY_ADMIN_HOST`, `COMMUNITY_ADMIN_PORT`, `COMMUNITY_ADMIN_ORIGIN` | `localhost`, `3001`, `http://localhost:3001` |
| Content retention | `CONTENT_RETENTION_DAYS` | `7`; allowed range is 1–180 days |
| SMS | `SMS_ENDPOINT`, `SMS_SIGN_NAME`, `SMS_TEMPLATE_CODE`, plus `SMS_CREDENTIALS_FILE` or `SMS_ECS_RAM_ROLE_NAME` | Alibaba Cloud SMS; set endpoint and sign name in the environment, then configure credentials and template in the console, or supply the complete static group with one credential mode |
| Speech and rewriting | `BAILIAN_API_KEY_FILE`, `BAILIAN_ASR_URL`, `BAILIAN_TEXT_BASE_URL`, `BAILIAN_TEXT_MODEL` | Supply the whole group; the model name must be accepted by the schema. Runtime model configuration is also available in the console |
| WeChat partner Native payment | `WECHAT_PAY_API_ORIGIN`, `WECHAT_PAY_SP_MERCHANT_ID`, `WECHAT_PAY_SP_APP_ID`, `WECHAT_PAY_SUB_MERCHANT_ID`, `WECHAT_PAY_SP_CERT_SERIAL`, `WECHAT_PAY_WECHAT_PUBLIC_KEY_ID`, `WECHAT_PAY_NOTIFY_URL`, `WECHAT_PAY_SP_PRIVATE_KEY_FILE`, `WECHAT_PAY_API_V3_KEY_FILE`, `WECHAT_PAY_WECHAT_PUBLIC_KEY_FILE` | Supply the whole group; otherwise payment sales are disabled |

SMS access-key files contain a JSON object with `accessKeyId` and `accessKeySecret`. Speech API-key files hold the key text. WeChat key files use the formats required by the payment provider. Keep secret files owner-readable only; the configuration loader rejects unsafe file types or permissions where supported. Administrator origin matching is exact. Local defaults are intended for development.

Windows uses filesystem ACLs; Unix permission-bit checks apply only on POSIX systems. Keep data and secret files in a directory accessible only to your Windows user.

## API overview

The route implementations define request schemas, authentication, response types, and limits. This table is an entry point rather than a replacement for those contracts.

| Capability | Method and path | Contract source |
| --- | --- | --- |
| Health | `GET /api/community/health/live`, `GET /api/community/health/ready` | [Application](src/app.ts) |
| SMS sign-in | `POST /api/community/v1/auth/sms/send`, `POST /api/community/v1/auth/sms/verify` | [Authentication](src/auth/authRoutes.ts) |
| Sessions | `POST /api/community/v1/auth/refresh`, `POST /api/community/v1/auth/logout`; `GET /api/community/v1/auth/me`, `GET /api/community/v1/auth/account-context` | [Authentication](src/auth/authRoutes.ts) |
| Recorded dictation | `POST /api/community/v1/dictations` | [Dictation](src/dictation/dictationRoutes.ts) |
| Streaming dictation | WebSocket upgrade at `/api/community/v2/realtime-dictations` | [Routes](src/realtime/streamingDictationRoutes.ts), [protocol](src/realtime/realtimeProtocol.ts) |
| Membership and usage | `GET /api/community/v1/billing/offer`, `GET /api/community/v1/billing/status` | [Billing](src/billing/billingRoutes.ts) |
| Orders | `POST /api/community/v1/billing/orders`; `GET /api/community/v1/billing/orders/current`, `GET /api/community/v1/billing/orders/:orderId`; `POST /api/community/v1/billing/orders/:orderId/recover` | [Billing](src/billing/billingRoutes.ts) |
| Payment callback | `POST /api/community/v1/billing/wechat/notify` | [Billing](src/billing/billingRoutes.ts) |
| Diagnostics | `POST /api/community/v1/diagnostic-reports` | [Diagnostics](src/diagnostics/diagnosticReportRoutes.ts) |
| Administrator UI and API | `/console/`, `/console/api/v1/...` on the administrator listener | [Administrator routes](src/admin/unified/adminRoutes.ts) |

The console includes users, administrator accounts, offers, orders, model configuration, SMS configuration, and feedback/diagnostics. Its sessions and authorization are separate from application-user sessions. Provider configuration and entitlement checks still apply when the server is healthy.

## Connecting TxChat Desktop

[TxChat Desktop](https://github.com/TxAi-Agent/TxChat-Desktop) is the companion Electron application. The desktop supplies the user interface and operating-system integration; Cloud supplies account, service, and billing APIs.

The public desktop's `ServiceAdapter` and `RecognitionProvider` default to an unconfigured/null state. Running Cloud or setting a base URL alone does not connect the two repositories. Implement and register the desktop adapters, map the authentication/session and billing contracts, and implement the recorded or streaming recognition protocol you intend to use. Configure both ends with your own service settings and validate the complete flow.

## License

Original project code is [Apache-2.0](LICENSE). Third-party components keep their own licenses; administrator CSS and icon fonts have separate [notices](THIRD_PARTY_NOTICES.md). The code license does not grant trademark rights: see [branding](TRADEMARKS.md).
