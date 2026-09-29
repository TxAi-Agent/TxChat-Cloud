# TxChat Cloud

[English](README.md) · [参与贡献](CONTRIBUTING.zh-CN.md) · [安全报告](SECURITY.zh-CN.md)

TxChat Cloud 是面向开发者的 TypeScript 语音应用后端，包含短信登录与会话、录音及实时听写、文本整理、会员与用量记账、支付订单处理、诊断提交和浏览器管理控制台。

仓库保留真实业务实现与可配置的外部服务适配器。短信、语音/模型或支付未配置时，相应能力保持不可用，不会返回伪造的成功结果。自动化测试中的替身仅用于隔离测试。

## 适用人群

开发者可以用它搭建后端、扩展供应商适配器，或将自己的应用接入 HTTP 与 WebSocket 接口。完整登录、识别、支付流程需要自行准备外部服务账号及配置；仓库不提供托管服务访问权或凭据。

## 本地开发

使用 Node.js 24 与 pnpm 11.19.0。SQLite 依赖包含原生绑定；平台没有匹配的预构建二进制时，需要相应的本机构建工具链。

```sh
npm install --global pnpm@11.19.0
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm dev
```

`pnpm verify` 会依次执行类型检查、服务及管理端构建、许可证核验、测试。以上命令描述开发流程；安装成功或服务开始监听不等于外部服务联调成功。

默认业务接口监听 `localhost:3000`，管理端监听 `localhost:3001`。管理页面请使用 `http://localhost:3001/console/`，以匹配默认管理端 Origin。两个监听端口承担不同职责。

全新启动会创建业务数据库结构，不自动添加示例用户、产品或外部供应商配置。会员权益检查始终生效。

服务默认使用 `.local-data/` 保存 SQLite 数据库、独立应用密钥与临时音频。全新数据目录会生成各用途的独立密钥；已有数据库依赖的密钥必须保留，丢失或替换密钥不能恢复加密内容。不要将数据目录提交到仓库。

首次启动会生成 `.local-data/administrator-setup.json`，内含创建首个管理员的短期链接。请在本机读取文件并打开链接完成初始化；链接有效期十分钟。尚未创建管理员时重启会签发新链接；已有管理员后再次初始化会移除该文件。设置链接属于秘密信息。

服务读取环境变量，`pnpm dev` 不会自动加载 `.env`。构建后需要显式加载时，可使用：

```sh
node --env-file=.env dist/server.js
```

## 配置

完整校验规则与默认值见 [配置源码](src/config.ts)。一个外部集成所需的字段应成组配置；不完整的凭据或非法值会被拒绝。秘密值从本地文件读取，不应写入源码。

| 用途 | 环境变量 | 默认值或行为 |
| --- | --- | --- |
| 应用环境 | `APP_ENV` | `development`，也接受 `test` 和 `production` |
| 数据及密钥 | `COMMUNITY_DATA_DIRECTORY`、`COMMUNITY_KEYS_FILE` | `.local-data/`；仅当数据全新且未显式指定密钥文件时生成密钥 |
| 业务监听 | `COMMUNITY_HOST`、`COMMUNITY_PORT` | `localhost`、`3000` |
| 管理监听 | `COMMUNITY_ADMIN_HOST`、`COMMUNITY_ADMIN_PORT`、`COMMUNITY_ADMIN_ORIGIN` | `localhost`、`3001`、`http://localhost:3001` |
| 内容保留时间 | `CONTENT_RETENTION_DAYS` | `7` 天，允许 1–180 天 |
| 短信 | `SMS_ENDPOINT`、`SMS_SIGN_NAME`、`SMS_TEMPLATE_CODE`，以及 `SMS_CREDENTIALS_FILE` 或 `SMS_ECS_RAM_ROLE_NAME` | 阿里云短信；先在环境中指定endpoint和签名，再通过管理端配置凭据及模板，或用完整静态配置并选择一种凭据方式 |
| 语音与文本整理 | `BAILIAN_API_KEY_FILE`、`BAILIAN_ASR_URL`、`BAILIAN_TEXT_BASE_URL`、`BAILIAN_TEXT_MODEL` | 四项成组配置，模型名须满足配置校验；管理端也支持运行时模型配置 |
| 微信服务商 Native 支付 | `WECHAT_PAY_API_ORIGIN`、`WECHAT_PAY_SP_MERCHANT_ID`、`WECHAT_PAY_SP_APP_ID`、`WECHAT_PAY_SUB_MERCHANT_ID`、`WECHAT_PAY_SP_CERT_SERIAL`、`WECHAT_PAY_WECHAT_PUBLIC_KEY_ID`、`WECHAT_PAY_NOTIFY_URL`、`WECHAT_PAY_SP_PRIVATE_KEY_FILE`、`WECHAT_PAY_API_V3_KEY_FILE`、`WECHAT_PAY_WECHAT_PUBLIC_KEY_FILE` | 成组配置，否则支付销售不可用 |

短信访问密钥文件为包含 `accessKeyId`、`accessKeySecret` 的 JSON 对象；语音 API 密钥文件保存密钥文本；微信支付密钥文件使用供应商要求的格式。秘密文件只允许所有者读取，配置加载器会在支持的平台拒绝不安全的文件类型或权限。管理端 Origin 必须精确匹配；默认配置用于本地开发。

Windows 使用文件系统 ACL；Unix 权限位检查仅适用于 POSIX 系统。请将数据和秘密文件保存在仅允许自己的 Windows 用户访问的目录中。

## 接口入口

请求结构、认证规则、响应与限制以路由源码为准，下表用于定位接口。

| 能力 | 方法与路径 | 契约源码 |
| --- | --- | --- |
| 健康状态 | `GET /api/community/health/live`、`GET /api/community/health/ready` | [应用](src/app.ts) |
| 短信登录 | `POST /api/community/v1/auth/sms/send`、`POST /api/community/v1/auth/sms/verify` | [认证](src/auth/authRoutes.ts) |
| 会话 | `POST /api/community/v1/auth/refresh`、`POST /api/community/v1/auth/logout`；`GET /api/community/v1/auth/me`、`GET /api/community/v1/auth/account-context` | [认证](src/auth/authRoutes.ts) |
| 录音听写 | `POST /api/community/v1/dictations` | [听写](src/dictation/dictationRoutes.ts) |
| 实时听写 | `/api/community/v2/realtime-dictations` 的 WebSocket 升级连接 | [路由](src/realtime/streamingDictationRoutes.ts)、[协议](src/realtime/realtimeProtocol.ts) |
| 会员及用量 | `GET /api/community/v1/billing/offer`、`GET /api/community/v1/billing/status` | [账单](src/billing/billingRoutes.ts) |
| 订单 | `POST /api/community/v1/billing/orders`；`GET /api/community/v1/billing/orders/current`、`GET /api/community/v1/billing/orders/:orderId`；`POST /api/community/v1/billing/orders/:orderId/recover` | [账单](src/billing/billingRoutes.ts) |
| 支付通知 | `POST /api/community/v1/billing/wechat/notify` | [账单](src/billing/billingRoutes.ts) |
| 诊断提交 | `POST /api/community/v1/diagnostic-reports` | [诊断](src/diagnostics/diagnosticReportRoutes.ts) |
| 管理页面与接口 | 管理端口上的 `/console/`、`/console/api/v1/...` | [管理路由](src/admin/unified/adminRoutes.ts) |

管理页面包含用户、管理员账号、套餐、订单、模型配置、短信配置与反馈/诊断。管理会话及权限独立于应用用户会话。即使服务健康，供应商配置与会员权益检查仍会决定业务请求是否可执行。

## 与 TxChat Desktop 配合

[TxChat Desktop](https://github.com/TxAi-Agent/TxChat-Desktop) 是配套的 Electron 桌面应用。桌面端负责界面及操作系统集成，Cloud 提供账号、服务及账单接口。

公开桌面端的 `ServiceAdapter`、`RecognitionProvider` 默认处于未配置/null 状态。仅启动 Cloud 或填写一个基础 URL 并不能完成两者连接。开发者需要实现并注册桌面适配器，对接认证/会话与账单契约，并实现需要的录音或实时识别协议，再使用自己的服务配置验证完整流程。

## 许可证

自有代码采用 [Apache-2.0](LICENSE)，[中文说明](LICENSE.zh-CN.md) 仅供理解。第三方组件继续适用各自许可证，管理端 CSS 和图标字体见 [第三方通知](THIRD_PARTY_NOTICES.md)。代码许可不授予商标权，见 [品牌说明](TRADEMARKS.md)。
