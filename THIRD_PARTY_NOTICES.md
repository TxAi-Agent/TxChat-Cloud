# 第三方组件通知 / Third-party notices

自有代码采用 Apache-2.0；下列第三方组件保留其各自许可。这里列出源码仓库声明的依赖，不将它们重新授权为 Apache-2.0。

Original project code is Apache-2.0. Third-party components retain their own licenses. This source distribution does not vendor node_modules, runtimes, or compiled application output.

## 管理端实际分发资源 / Administrator assets

构建会从锁定依赖复制 Tabler CSS 与 Tabler Icons 字体，并在图标 CSS 中规范化本地字体 URL。Tabler CSS 包含 Bootstrap 样式。完整许可证如下，分发构建产物时也必须保留这些文件：

| Component | Version | License | Full text | Official source |
| --- | --- | --- | --- | --- |
| @tabler/core | 1.4.0 | MIT | [License](licenses/tabler-core-LICENSE) | [Version source](https://github.com/tabler/tabler/tree/%40tabler%2Fcore%401.4.0) |
| @tabler/icons-webfont / @tabler/icons | 3.46.0 | MIT | [License](licenses/tabler-icons-LICENSE) | [Version source](https://github.com/tabler/tabler-icons/tree/v3.46.0) |
| Bootstrap (included CSS) | 5.3.7 | MIT | [License](licenses/bootstrap-LICENSE) | [Version source](https://github.com/twbs/bootstrap/tree/v5.3.7) |

Tabler Icons 的 woff、woff2、ttf 文件属于上述 MIT 许可的图标字体。Inter、Segoe UI、PingFang 等仅出现在 CSS 字体回退列表，本仓库不附带这些文字字体文件。品牌图标的版权许可不等于商标授权。

The copied icon font is covered by the Tabler Icons MIT license. Text font family references select fonts available on the user’s system; the project does not ship those text font files. Copyright licenses for icons do not grant trademark rights.

## 安装与再分发 / Installation and redistribution

依赖通过 package.json 与 pnpm-lock.yaml 安装，许可证声明来自锁定版本的包元数据，Tabler Icons Webfont 以实际 LICENSE 原文为准。发布仅含本项目源码与依赖声明时不应附带 node_modules。若另行分发容器、预构建服务或完整依赖副本，必须保留随包提供的 LICENSE、NOTICE、COPYING 及代码中的归属通知，并核对所有嵌入组件；本清单不能替代这些原文。

Dependency license declarations were checked against installed package metadata or the exact version on the npm registry. The webfont package omits its metadata license field; its included and upstream versioned LICENSE confirm MIT. Keep each dependency’s complete notices when redistributing dependency code or binaries, including embedded components.

构建/测试链中的 Lightning CSS 1.33.0 及各平台绑定采用 MPL-2.0。它们不在服务运行闭包中；若分发这些文件，需要遵守文件级源码及通知义务。使用构建工具不会将本项目自有代码整体改为 MPL。见 [Mozilla MPL FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/)。

Lightning CSS and its platform bindings are MPL-2.0 development dependencies. Distributing those components requires complying with their source-availability and notice requirements; using a build tool does not relicense original project code.

此外，pako 的声明为 MIT AND Zlib；不可遗漏 lib/zlib 源文件中的 Zlib 通知。TypeScript 的 NOTICE.txt 和其他构建工具的复合许可证包含嵌入组件声明，不能只保留顶层 SPDX 名称。better-sqlite3 使用 MIT，其 SQLite 引擎依据 [SQLite 官方版权说明](https://www.sqlite.org/copyright.html) 属于公有领域；Node.js、pnpm 运行时不包含在本源码分发中。

## 锁定依赖清单 / Locked dependency inventory

Checked: 2026-09-29. Lockfile SHA-256: `b4e48c09dce881514a5dfb271a82ca14a8846a47b4146ae195d84c580de381ca`. 438 distinct package versions, including 130 in the runtime dependency graph (optional platform entries included). “Development” covers build/test-only packages, while copied administrator assets are also distributed to browsers.

| Package | Version | Scope | Declared license | Version metadata |
| --- | --- | --- | --- | --- |
| @alicloud/credentials | 2.4.7 | Direct runtime | MIT | [npm](https://registry.npmjs.org/%40alicloud%2Fcredentials/2.4.7) |
| @alicloud/darabonba-array | 0.1.2 | Runtime | ISC | [npm](https://registry.npmjs.org/%40alicloud%2Fdarabonba-array/0.1.2) |
| @alicloud/darabonba-encode-util | 0.0.1 | Runtime | ISC | [npm](https://registry.npmjs.org/%40alicloud%2Fdarabonba-encode-util/0.0.1) |
| @alicloud/darabonba-encode-util | 0.0.2 | Runtime | ISC | [npm](https://registry.npmjs.org/%40alicloud%2Fdarabonba-encode-util/0.0.2) |
| @alicloud/darabonba-map | 0.0.1 | Runtime | ISC | [npm](https://registry.npmjs.org/%40alicloud%2Fdarabonba-map/0.0.1) |
| @alicloud/darabonba-signature-util | 0.0.4 | Runtime | ISC | [npm](https://registry.npmjs.org/%40alicloud%2Fdarabonba-signature-util/0.0.4) |
| @alicloud/darabonba-string | 1.0.3 | Runtime | Apache-2.0 | [npm](https://registry.npmjs.org/%40alicloud%2Fdarabonba-string/1.0.3) |
| @alicloud/dysmsapi20170525 | 4.6.0 | Direct runtime | Apache-2.0 | [npm](https://registry.npmjs.org/%40alicloud%2Fdysmsapi20170525/4.6.0) |
| @alicloud/endpoint-util | 0.0.1 | Runtime | Apache-2.0 | [npm](https://registry.npmjs.org/%40alicloud%2Fendpoint-util/0.0.1) |
| @alicloud/gateway-pop | 0.0.6 | Runtime | ISC | [npm](https://registry.npmjs.org/%40alicloud%2Fgateway-pop/0.0.6) |
| @alicloud/gateway-spi | 0.0.8 | Runtime | ISC | [npm](https://registry.npmjs.org/%40alicloud%2Fgateway-spi/0.0.8) |
| @alicloud/openapi-client | 0.4.15 | Direct runtime | ISC | [npm](https://registry.npmjs.org/%40alicloud%2Fopenapi-client/0.4.15) |
| @alicloud/openapi-core | 1.0.8 | Runtime | ISC | [npm](https://registry.npmjs.org/%40alicloud%2Fopenapi-core/1.0.8) |
| @alicloud/openapi-util | 0.3.3 | Runtime | ISC | [npm](https://registry.npmjs.org/%40alicloud%2Fopenapi-util/0.3.3) |
| @alicloud/tea-typescript | 1.8.0 | Runtime | ISC | [npm](https://registry.npmjs.org/%40alicloud%2Ftea-typescript/1.8.0) |
| @alicloud/tea-util | 1.4.11 | Direct runtime | Apache-2.0 | [npm](https://registry.npmjs.org/%40alicloud%2Ftea-util/1.4.11) |
| @alicloud/tea-util | 1.4.9 | Runtime | Apache-2.0 | [npm](https://registry.npmjs.org/%40alicloud%2Ftea-util/1.4.9) |
| @alicloud/tea-xml | 0.0.3 | Runtime | Apache-2.0 | [npm](https://registry.npmjs.org/%40alicloud%2Ftea-xml/0.0.3) |
| @darabonba/typescript | 1.0.5 | Runtime | Apache-2.0 | [npm](https://registry.npmjs.org/%40darabonba%2Ftypescript/1.0.5) |
| @esbuild/aix-ppc64 | 0.28.2 | Development | MIT | [npm](https://registry.npmjs.org/%40esbuild%2Faix-ppc64/0.28.2) |
| @esbuild/android-arm64 | 0.28.2 | Development | MIT | [npm](https://registry.npmjs.org/%40esbuild%2Fandroid-arm64/0.28.2) |
| @esbuild/android-arm | 0.28.2 | Development | MIT | [npm](https://registry.npmjs.org/%40esbuild%2Fandroid-arm/0.28.2) |
| @esbuild/android-x64 | 0.28.2 | Development | MIT | [npm](https://registry.npmjs.org/%40esbuild%2Fandroid-x64/0.28.2) |
| @esbuild/darwin-arm64 | 0.28.2 | Development | MIT | [npm](https://registry.npmjs.org/%40esbuild%2Fdarwin-arm64/0.28.2) |
| @esbuild/darwin-x64 | 0.28.2 | Development | MIT | [npm](https://registry.npmjs.org/%40esbuild%2Fdarwin-x64/0.28.2) |
| @esbuild/freebsd-arm64 | 0.28.2 | Development | MIT | [npm](https://registry.npmjs.org/%40esbuild%2Ffreebsd-arm64/0.28.2) |
| @esbuild/freebsd-x64 | 0.28.2 | Development | MIT | [npm](https://registry.npmjs.org/%40esbuild%2Ffreebsd-x64/0.28.2) |
| @esbuild/linux-arm64 | 0.28.2 | Development | MIT | [npm](https://registry.npmjs.org/%40esbuild%2Flinux-arm64/0.28.2) |
| @esbuild/linux-arm | 0.28.2 | Development | MIT | [npm](https://registry.npmjs.org/%40esbuild%2Flinux-arm/0.28.2) |
| @esbuild/linux-ia32 | 0.28.2 | Development | MIT | [npm](https://registry.npmjs.org/%40esbuild%2Flinux-ia32/0.28.2) |
| @esbuild/linux-loong64 | 0.28.2 | Development | MIT | [npm](https://registry.npmjs.org/%40esbuild%2Flinux-loong64/0.28.2) |
| @esbuild/linux-mips64el | 0.28.2 | Development | MIT | [npm](https://registry.npmjs.org/%40esbuild%2Flinux-mips64el/0.28.2) |
| @esbuild/linux-ppc64 | 0.28.2 | Development | MIT | [npm](https://registry.npmjs.org/%40esbuild%2Flinux-ppc64/0.28.2) |
| @esbuild/linux-riscv64 | 0.28.2 | Development | MIT | [npm](https://registry.npmjs.org/%40esbuild%2Flinux-riscv64/0.28.2) |
| @esbuild/linux-s390x | 0.28.2 | Development | MIT | [npm](https://registry.npmjs.org/%40esbuild%2Flinux-s390x/0.28.2) |
| @esbuild/linux-x64 | 0.28.2 | Development | MIT | [npm](https://registry.npmjs.org/%40esbuild%2Flinux-x64/0.28.2) |
| @esbuild/netbsd-arm64 | 0.28.2 | Development | MIT | [npm](https://registry.npmjs.org/%40esbuild%2Fnetbsd-arm64/0.28.2) |
| @esbuild/netbsd-x64 | 0.28.2 | Development | MIT | [npm](https://registry.npmjs.org/%40esbuild%2Fnetbsd-x64/0.28.2) |
| @esbuild/openbsd-arm64 | 0.28.2 | Development | MIT | [npm](https://registry.npmjs.org/%40esbuild%2Fopenbsd-arm64/0.28.2) |
| @esbuild/openbsd-x64 | 0.28.2 | Development | MIT | [npm](https://registry.npmjs.org/%40esbuild%2Fopenbsd-x64/0.28.2) |
| @esbuild/openharmony-arm64 | 0.28.2 | Development | MIT | [npm](https://registry.npmjs.org/%40esbuild%2Fopenharmony-arm64/0.28.2) |
| @esbuild/sunos-x64 | 0.28.2 | Development | MIT | [npm](https://registry.npmjs.org/%40esbuild%2Fsunos-x64/0.28.2) |
| @esbuild/win32-arm64 | 0.28.2 | Development | MIT | [npm](https://registry.npmjs.org/%40esbuild%2Fwin32-arm64/0.28.2) |
| @esbuild/win32-ia32 | 0.28.2 | Development | MIT | [npm](https://registry.npmjs.org/%40esbuild%2Fwin32-ia32/0.28.2) |
| @esbuild/win32-x64 | 0.28.2 | Development | MIT | [npm](https://registry.npmjs.org/%40esbuild%2Fwin32-x64/0.28.2) |
| @fastify/ajv-compiler | 4.0.6 | Runtime | MIT | [npm](https://registry.npmjs.org/%40fastify%2Fajv-compiler/4.0.6) |
| @fastify/busboy | 3.2.2 | Runtime | MIT | [npm](https://registry.npmjs.org/%40fastify%2Fbusboy/3.2.2) |
| @fastify/deepmerge | 3.2.1 | Runtime | MIT | [npm](https://registry.npmjs.org/%40fastify%2Fdeepmerge/3.2.1) |
| @fastify/error | 4.2.0 | Runtime | MIT | [npm](https://registry.npmjs.org/%40fastify%2Ferror/4.2.0) |
| @fastify/fast-json-stringify-compiler | 5.1.0 | Runtime | MIT | [npm](https://registry.npmjs.org/%40fastify%2Ffast-json-stringify-compiler/5.1.0) |
| @fastify/forwarded | 3.0.2 | Runtime | MIT | [npm](https://registry.npmjs.org/%40fastify%2Fforwarded/3.0.2) |
| @fastify/jwt | 10.2.1 | Direct runtime | MIT | [npm](https://registry.npmjs.org/%40fastify%2Fjwt/10.2.1) |
| @fastify/merge-json-schemas | 0.2.1 | Runtime | MIT | [npm](https://registry.npmjs.org/%40fastify%2Fmerge-json-schemas/0.2.1) |
| @fastify/multipart | 10.1.0 | Direct runtime | MIT | [npm](https://registry.npmjs.org/%40fastify%2Fmultipart/10.1.0) |
| @fastify/proxy-addr | 5.1.1 | Runtime | MIT | [npm](https://registry.npmjs.org/%40fastify%2Fproxy-addr/5.1.1) |
| @fastify/rate-limit | 11.1.0 | Direct runtime | MIT | [npm](https://registry.npmjs.org/%40fastify%2Frate-limit/11.1.0) |
| @fastify/websocket | 11.3.0 | Direct runtime | MIT | [npm](https://registry.npmjs.org/%40fastify%2Fwebsocket/11.3.0) |
| @isaacs/cliui | 8.0.2 | Development | ISC | [npm](https://registry.npmjs.org/%40isaacs%2Fcliui/8.0.2) |
| @isaacs/cliui | 9.0.0 | Development | BlueOak-1.0.0 | [npm](https://registry.npmjs.org/%40isaacs%2Fcliui/9.0.0) |
| @isaacs/fs-minipass | 4.0.1 | Development | ISC | [npm](https://registry.npmjs.org/%40isaacs%2Ffs-minipass/4.0.1) |
| @jridgewell/gen-mapping | 0.3.13 | Development | MIT | [npm](https://registry.npmjs.org/%40jridgewell%2Fgen-mapping/0.3.13) |
| @jridgewell/resolve-uri | 3.1.2 | Development | MIT | [npm](https://registry.npmjs.org/%40jridgewell%2Fresolve-uri/3.1.2) |
| @jridgewell/sourcemap-codec | 1.6.0 | Development | MIT | [npm](https://registry.npmjs.org/%40jridgewell%2Fsourcemap-codec/1.6.0) |
| @jridgewell/trace-mapping | 0.3.31 | Development | MIT | [npm](https://registry.npmjs.org/%40jridgewell%2Ftrace-mapping/0.3.31) |
| @lukeed/ms | 2.0.2 | Runtime | MIT | [npm](https://registry.npmjs.org/%40lukeed%2Fms/2.0.2) |
| @npmcli/agent | 3.0.0 | Development | ISC | [npm](https://registry.npmjs.org/%40npmcli%2Fagent/3.0.0) |
| @npmcli/fs | 4.0.0 | Development | ISC | [npm](https://registry.npmjs.org/%40npmcli%2Ffs/4.0.0) |
| @oxc-project/types | 0.151.0 | Development | MIT | [npm](https://registry.npmjs.org/%40oxc-project%2Ftypes/0.151.0) |
| @pinojs/redact | 0.4.0 | Runtime | MIT | [npm](https://registry.npmjs.org/%40pinojs%2Fredact/0.4.0) |
| @pkgjs/parseargs | 0.11.0 | Development | MIT | [npm](https://registry.npmjs.org/%40pkgjs%2Fparseargs/0.11.0) |
| @popperjs/core | 2.11.8 | Development | MIT | [npm](https://registry.npmjs.org/%40popperjs%2Fcore/2.11.8) |
| @rolldown/binding-android-arm-eabi | 1.2.11 | Development | MIT | [npm](https://registry.npmjs.org/%40rolldown%2Fbinding-android-arm-eabi/1.2.11) |
| @rolldown/binding-android-arm64 | 1.2.11 | Development | MIT | [npm](https://registry.npmjs.org/%40rolldown%2Fbinding-android-arm64/1.2.11) |
| @rolldown/binding-darwin-arm64 | 1.2.11 | Development | MIT | [npm](https://registry.npmjs.org/%40rolldown%2Fbinding-darwin-arm64/1.2.11) |
| @rolldown/binding-darwin-x64 | 1.2.11 | Development | MIT | [npm](https://registry.npmjs.org/%40rolldown%2Fbinding-darwin-x64/1.2.11) |
| @rolldown/binding-freebsd-x64 | 1.2.11 | Development | MIT | [npm](https://registry.npmjs.org/%40rolldown%2Fbinding-freebsd-x64/1.2.11) |
| @rolldown/binding-linux-arm-gnueabihf | 1.2.11 | Development | MIT | [npm](https://registry.npmjs.org/%40rolldown%2Fbinding-linux-arm-gnueabihf/1.2.11) |
| @rolldown/binding-linux-arm64-gnu | 1.2.11 | Development | MIT | [npm](https://registry.npmjs.org/%40rolldown%2Fbinding-linux-arm64-gnu/1.2.11) |
| @rolldown/binding-linux-arm64-musl | 1.2.11 | Development | MIT | [npm](https://registry.npmjs.org/%40rolldown%2Fbinding-linux-arm64-musl/1.2.11) |
| @rolldown/binding-linux-ppc64-gnu | 1.2.11 | Development | MIT | [npm](https://registry.npmjs.org/%40rolldown%2Fbinding-linux-ppc64-gnu/1.2.11) |
| @rolldown/binding-linux-s390x-gnu | 1.2.11 | Development | MIT | [npm](https://registry.npmjs.org/%40rolldown%2Fbinding-linux-s390x-gnu/1.2.11) |
| @rolldown/binding-linux-x64-gnu | 1.2.11 | Development | MIT | [npm](https://registry.npmjs.org/%40rolldown%2Fbinding-linux-x64-gnu/1.2.11) |
| @rolldown/binding-linux-x64-musl | 1.2.11 | Development | MIT | [npm](https://registry.npmjs.org/%40rolldown%2Fbinding-linux-x64-musl/1.2.11) |
| @rolldown/binding-openharmony-arm64 | 1.2.11 | Development | MIT | [npm](https://registry.npmjs.org/%40rolldown%2Fbinding-openharmony-arm64/1.2.11) |
| @rolldown/binding-win32-arm64-msvc | 1.2.11 | Development | MIT | [npm](https://registry.npmjs.org/%40rolldown%2Fbinding-win32-arm64-msvc/1.2.11) |
| @rolldown/binding-win32-x64-msvc | 1.2.11 | Development | MIT | [npm](https://registry.npmjs.org/%40rolldown%2Fbinding-win32-x64-msvc/1.2.11) |
| @rolldown/pluginutils | 1.0.1 | Development | MIT | [npm](https://registry.npmjs.org/%40rolldown%2Fpluginutils/1.0.1) |
| @standard-schema/spec | 1.1.0 | Development | MIT | [npm](https://registry.npmjs.org/%40standard-schema%2Fspec/1.1.0) |
| @tabler/core | 1.4.0 | Direct development | MIT | [npm](https://registry.npmjs.org/%40tabler%2Fcore/1.4.0) |
| @tabler/icons-webfont | 3.46.0 | Direct development | MIT | [npm](https://registry.npmjs.org/%40tabler%2Ficons-webfont/3.46.0) |
| @tabler/icons | 3.46.0 | Development | MIT | [npm](https://registry.npmjs.org/%40tabler%2Ficons/3.46.0) |
| @thednp/dommatrix | 3.1.2 | Development | MIT | [npm](https://registry.npmjs.org/%40thednp%2Fdommatrix/3.1.2) |
| @tootallnate/once | 2.0.1 | Runtime | MIT | [npm](https://registry.npmjs.org/%40tootallnate%2Fonce/2.0.1) |
| @types/better-sqlite3 | 7.6.13 | Direct development | MIT | [npm](https://registry.npmjs.org/%40types%2Fbetter-sqlite3/7.6.13) |
| @types/chai | 5.2.3 | Development | MIT | [npm](https://registry.npmjs.org/%40types%2Fchai/5.2.3) |
| @types/deep-eql | 4.0.2 | Development | MIT | [npm](https://registry.npmjs.org/%40types%2Fdeep-eql/4.0.2) |
| @types/estree | 1.0.9 | Development | MIT | [npm](https://registry.npmjs.org/%40types%2Festree/1.0.9) |
| @types/node | 12.20.55 | Runtime | MIT | [npm](https://registry.npmjs.org/%40types%2Fnode/12.20.55) |
| @types/node | 20.19.43 | Runtime | MIT | [npm](https://registry.npmjs.org/%40types%2Fnode/20.19.43) |
| @types/node | 22.20.4 | Runtime | MIT | [npm](https://registry.npmjs.org/%40types%2Fnode/22.20.4) |
| @types/node | 24.13.3 | Direct development | MIT | [npm](https://registry.npmjs.org/%40types%2Fnode/24.13.3) |
| @types/sax | 1.2.7 | Development | MIT | [npm](https://registry.npmjs.org/%40types%2Fsax/1.2.7) |
| @types/ws | 8.18.1 | Direct development | MIT | [npm](https://registry.npmjs.org/%40types%2Fws/8.18.1) |
| @types/xml2js | 0.4.14 | Runtime | MIT | [npm](https://registry.npmjs.org/%40types%2Fxml2js/0.4.14) |
| @typescript/typescript-aix-ppc64 | 7.0.2 | Development | Apache-2.0 | [npm](https://registry.npmjs.org/%40typescript%2Ftypescript-aix-ppc64/7.0.2) |
| @typescript/typescript-darwin-arm64 | 7.0.2 | Development | Apache-2.0 | [npm](https://registry.npmjs.org/%40typescript%2Ftypescript-darwin-arm64/7.0.2) |
| @typescript/typescript-darwin-x64 | 7.0.2 | Development | Apache-2.0 | [npm](https://registry.npmjs.org/%40typescript%2Ftypescript-darwin-x64/7.0.2) |
| @typescript/typescript-freebsd-arm64 | 7.0.2 | Development | Apache-2.0 | [npm](https://registry.npmjs.org/%40typescript%2Ftypescript-freebsd-arm64/7.0.2) |
| @typescript/typescript-freebsd-x64 | 7.0.2 | Development | Apache-2.0 | [npm](https://registry.npmjs.org/%40typescript%2Ftypescript-freebsd-x64/7.0.2) |
| @typescript/typescript-linux-arm64 | 7.0.2 | Development | Apache-2.0 | [npm](https://registry.npmjs.org/%40typescript%2Ftypescript-linux-arm64/7.0.2) |
| @typescript/typescript-linux-arm | 7.0.2 | Development | Apache-2.0 | [npm](https://registry.npmjs.org/%40typescript%2Ftypescript-linux-arm/7.0.2) |
| @typescript/typescript-linux-loong64 | 7.0.2 | Development | Apache-2.0 | [npm](https://registry.npmjs.org/%40typescript%2Ftypescript-linux-loong64/7.0.2) |
| @typescript/typescript-linux-mips64el | 7.0.2 | Development | Apache-2.0 | [npm](https://registry.npmjs.org/%40typescript%2Ftypescript-linux-mips64el/7.0.2) |
| @typescript/typescript-linux-ppc64 | 7.0.2 | Development | Apache-2.0 | [npm](https://registry.npmjs.org/%40typescript%2Ftypescript-linux-ppc64/7.0.2) |
| @typescript/typescript-linux-riscv64 | 7.0.2 | Development | Apache-2.0 | [npm](https://registry.npmjs.org/%40typescript%2Ftypescript-linux-riscv64/7.0.2) |
| @typescript/typescript-linux-s390x | 7.0.2 | Development | Apache-2.0 | [npm](https://registry.npmjs.org/%40typescript%2Ftypescript-linux-s390x/7.0.2) |
| @typescript/typescript-linux-x64 | 7.0.2 | Development | Apache-2.0 | [npm](https://registry.npmjs.org/%40typescript%2Ftypescript-linux-x64/7.0.2) |
| @typescript/typescript-netbsd-arm64 | 7.0.2 | Development | Apache-2.0 | [npm](https://registry.npmjs.org/%40typescript%2Ftypescript-netbsd-arm64/7.0.2) |
| @typescript/typescript-netbsd-x64 | 7.0.2 | Development | Apache-2.0 | [npm](https://registry.npmjs.org/%40typescript%2Ftypescript-netbsd-x64/7.0.2) |
| @typescript/typescript-openbsd-arm64 | 7.0.2 | Development | Apache-2.0 | [npm](https://registry.npmjs.org/%40typescript%2Ftypescript-openbsd-arm64/7.0.2) |
| @typescript/typescript-openbsd-x64 | 7.0.2 | Development | Apache-2.0 | [npm](https://registry.npmjs.org/%40typescript%2Ftypescript-openbsd-x64/7.0.2) |
| @typescript/typescript-sunos-x64 | 7.0.2 | Development | Apache-2.0 | [npm](https://registry.npmjs.org/%40typescript%2Ftypescript-sunos-x64/7.0.2) |
| @typescript/typescript-win32-arm64 | 7.0.2 | Development | Apache-2.0 | [npm](https://registry.npmjs.org/%40typescript%2Ftypescript-win32-arm64/7.0.2) |
| @typescript/typescript-win32-x64 | 7.0.2 | Development | Apache-2.0 | [npm](https://registry.npmjs.org/%40typescript%2Ftypescript-win32-x64/7.0.2) |
| @vitest/expect | 4.1.11 | Development | MIT | [npm](https://registry.npmjs.org/%40vitest%2Fexpect/4.1.11) |
| @vitest/mocker | 4.1.11 | Development | MIT | [npm](https://registry.npmjs.org/%40vitest%2Fmocker/4.1.11) |
| @vitest/pretty-format | 4.1.11 | Development | MIT | [npm](https://registry.npmjs.org/%40vitest%2Fpretty-format/4.1.11) |
| @vitest/runner | 4.1.11 | Development | MIT | [npm](https://registry.npmjs.org/%40vitest%2Frunner/4.1.11) |
| @vitest/snapshot | 4.1.11 | Development | MIT | [npm](https://registry.npmjs.org/%40vitest%2Fsnapshot/4.1.11) |
| @vitest/spy | 4.1.11 | Development | MIT | [npm](https://registry.npmjs.org/%40vitest%2Fspy/4.1.11) |
| @vitest/utils | 4.1.11 | Development | MIT | [npm](https://registry.npmjs.org/%40vitest%2Futils/4.1.11) |
| @xmldom/xmldom | 0.9.12 | Development | MIT | [npm](https://registry.npmjs.org/%40xmldom%2Fxmldom/0.9.12) |
| a-sync-waterfall | 1.0.1 | Development | MIT | [npm](https://registry.npmjs.org/a-sync-waterfall/1.0.1) |
| abbrev | 3.0.1 | Development | ISC | [npm](https://registry.npmjs.org/abbrev/3.0.1) |
| abstract-logging | 2.0.1 | Runtime | MIT | [npm](https://registry.npmjs.org/abstract-logging/2.0.1) |
| acorn-jsx | 5.3.2 | Development | MIT | [npm](https://registry.npmjs.org/acorn-jsx/5.3.2) |
| acorn | 8.18.0 | Development | MIT | [npm](https://registry.npmjs.org/acorn/8.18.0) |
| agent-base | 6.0.2 | Runtime | MIT | [npm](https://registry.npmjs.org/agent-base/6.0.2) |
| agent-base | 7.1.4 | Development | MIT | [npm](https://registry.npmjs.org/agent-base/7.1.4) |
| ajv-formats | 3.0.1 | Runtime | MIT | [npm](https://registry.npmjs.org/ajv-formats/3.0.1) |
| ajv | 8.20.0 | Runtime | MIT | [npm](https://registry.npmjs.org/ajv/8.20.0) |
| ansi-regex | 5.0.1 | Development | MIT | [npm](https://registry.npmjs.org/ansi-regex/5.0.1) |
| ansi-regex | 6.4.0 | Development | MIT | [npm](https://registry.npmjs.org/ansi-regex/6.4.0) |
| ansi-styles | 4.3.0 | Development | MIT | [npm](https://registry.npmjs.org/ansi-styles/4.3.0) |
| ansi-styles | 6.2.3 | Development | MIT | [npm](https://registry.npmjs.org/ansi-styles/6.2.3) |
| any-promise | 1.3.0 | Development | MIT | [npm](https://registry.npmjs.org/any-promise/1.3.0) |
| argparse | 2.0.1 | Development | Python-2.0 | [npm](https://registry.npmjs.org/argparse/2.0.1) |
| asap | 2.0.6 | Development | MIT | [npm](https://registry.npmjs.org/asap/2.0.6) |
| asn1.js | 5.4.1 | Runtime | MIT | [npm](https://registry.npmjs.org/asn1.js/5.4.1) |
| assertion-error | 2.0.1 | Development | MIT | [npm](https://registry.npmjs.org/assertion-error/2.0.1) |
| atomic-sleep | 1.0.0 | Runtime | MIT | [npm](https://registry.npmjs.org/atomic-sleep/1.0.0) |
| auto-config-loader | 2.0.2 | Development | MIT | [npm](https://registry.npmjs.org/auto-config-loader/2.0.2) |
| avvio | 9.3.0 | Runtime | MIT | [npm](https://registry.npmjs.org/avvio/9.3.0) |
| balanced-match | 1.0.2 | Development | MIT | [npm](https://registry.npmjs.org/balanced-match/1.0.2) |
| balanced-match | 4.0.4 | Development | MIT | [npm](https://registry.npmjs.org/balanced-match/4.0.4) |
| better-sqlite3 | 13.0.1 | Direct runtime | MIT | [npm](https://registry.npmjs.org/better-sqlite3/13.0.1) |
| bindings | 1.5.0 | Development | MIT | [npm](https://registry.npmjs.org/bindings/1.5.0) |
| bn.js | 4.12.5 | Runtime | MIT | [npm](https://registry.npmjs.org/bn.js/4.12.5) |
| boolbase | 1.0.0 | Development | ISC | [npm](https://registry.npmjs.org/boolbase/1.0.0) |
| bootstrap | 5.3.7 | Development | MIT | [npm](https://registry.npmjs.org/bootstrap/5.3.7) |
| brace-expansion | 2.1.7 | Development | MIT | [npm](https://registry.npmjs.org/brace-expansion/2.1.7) |
| brace-expansion | 5.0.12 | Development | MIT | [npm](https://registry.npmjs.org/brace-expansion/5.0.12) |
| bufferstreams | 4.0.0 | Development | MIT | [npm](https://registry.npmjs.org/bufferstreams/4.0.0) |
| cacache | 19.0.1 | Development | ISC | [npm](https://registry.npmjs.org/cacache/19.0.1) |
| chai | 6.2.2 | Development | MIT | [npm](https://registry.npmjs.org/chai/6.2.2) |
| cheerio-select | 2.1.0 | Development | BSD-2-Clause | [npm](https://registry.npmjs.org/cheerio-select/2.1.0) |
| cheerio | 1.0.0 | Development | MIT | [npm](https://registry.npmjs.org/cheerio/1.0.0) |
| chownr | 3.0.0 | Development | BlueOak-1.0.0 | [npm](https://registry.npmjs.org/chownr/3.0.0) |
| cliui | 8.0.1 | Development | ISC | [npm](https://registry.npmjs.org/cliui/8.0.1) |
| color-convert | 2.0.1 | Development | MIT | [npm](https://registry.npmjs.org/color-convert/2.0.1) |
| color-name | 1.1.4 | Development | MIT | [npm](https://registry.npmjs.org/color-name/1.1.4) |
| colors-cli | 1.0.33 | Development | MIT | [npm](https://registry.npmjs.org/colors-cli/1.0.33) |
| commander | 12.1.0 | Development | MIT | [npm](https://registry.npmjs.org/commander/12.1.0) |
| commander | 4.1.1 | Development | MIT | [npm](https://registry.npmjs.org/commander/4.1.1) |
| commander | 5.1.0 | Development | MIT | [npm](https://registry.npmjs.org/commander/5.1.0) |
| commander | 7.2.0 | Development | MIT | [npm](https://registry.npmjs.org/commander/7.2.0) |
| content-type | 2.1.0 | Development | MIT | [npm](https://registry.npmjs.org/content-type/2.1.0) |
| convert-source-map | 2.0.0 | Development | MIT | [npm](https://registry.npmjs.org/convert-source-map/2.0.0) |
| cookie | 1.1.1 | Runtime | MIT | [npm](https://registry.npmjs.org/cookie/1.1.1) |
| cross-spawn | 7.0.6 | Development | MIT | [npm](https://registry.npmjs.org/cross-spawn/7.0.6) |
| css-select | 5.2.2 | Development | BSD-2-Clause | [npm](https://registry.npmjs.org/css-select/5.2.2) |
| css-tree | 2.2.1 | Development | MIT | [npm](https://registry.npmjs.org/css-tree/2.2.1) |
| css-tree | 2.3.1 | Development | MIT | [npm](https://registry.npmjs.org/css-tree/2.3.1) |
| css-what | 6.2.2 | Development | BSD-2-Clause | [npm](https://registry.npmjs.org/css-what/6.2.2) |
| csso | 5.0.5 | Development | MIT | [npm](https://registry.npmjs.org/csso/5.0.5) |
| cubic2quad | 1.2.1 | Development | MIT | [npm](https://registry.npmjs.org/cubic2quad/1.2.1) |
| data-uri-to-buffer | 4.0.1 | Development | MIT | [npm](https://registry.npmjs.org/data-uri-to-buffer/4.0.1) |
| debug | 4.4.3 | Runtime | MIT | [npm](https://registry.npmjs.org/debug/4.4.3) |
| dequal | 2.0.3 | Runtime | MIT | [npm](https://registry.npmjs.org/dequal/2.0.3) |
| detect-libc | 2.1.2 | Development | Apache-2.0 | [npm](https://registry.npmjs.org/detect-libc/2.1.2) |
| dom-serializer | 2.0.0 | Development | MIT | [npm](https://registry.npmjs.org/dom-serializer/2.0.0) |
| domelementtype | 2.3.0 | Development | BSD-2-Clause | [npm](https://registry.npmjs.org/domelementtype/2.3.0) |
| domhandler | 5.0.3 | Development | BSD-2-Clause | [npm](https://registry.npmjs.org/domhandler/5.0.3) |
| domutils | 3.2.2 | Development | BSD-2-Clause | [npm](https://registry.npmjs.org/domutils/3.2.2) |
| duplexify | 4.1.3 | Runtime | MIT | [npm](https://registry.npmjs.org/duplexify/4.1.3) |
| eastasianwidth | 0.2.0 | Development | MIT | [npm](https://registry.npmjs.org/eastasianwidth/0.2.0) |
| ecdsa-sig-formatter | 1.0.11 | Runtime | Apache-2.0 | [npm](https://registry.npmjs.org/ecdsa-sig-formatter/1.0.11) |
| emoji-regex | 8.0.0 | Development | MIT | [npm](https://registry.npmjs.org/emoji-regex/8.0.0) |
| emoji-regex | 9.2.2 | Development | MIT | [npm](https://registry.npmjs.org/emoji-regex/9.2.2) |
| encoding-sniffer | 0.2.1 | Development | MIT | [npm](https://registry.npmjs.org/encoding-sniffer/0.2.1) |
| encoding | 0.1.13 | Development | MIT | [npm](https://registry.npmjs.org/encoding/0.1.13) |
| end-of-stream | 1.4.5 | Runtime | MIT | [npm](https://registry.npmjs.org/end-of-stream/1.4.5) |
| entities | 4.5.0 | Development | BSD-2-Clause | [npm](https://registry.npmjs.org/entities/4.5.0) |
| entities | 6.0.1 | Development | BSD-2-Clause | [npm](https://registry.npmjs.org/entities/6.0.1) |
| env-paths | 2.2.1 | Development | MIT | [npm](https://registry.npmjs.org/env-paths/2.2.1) |
| err-code | 2.0.3 | Development | MIT | [npm](https://registry.npmjs.org/err-code/2.0.3) |
| es-module-lexer | 2.3.2 | Development | MIT | [npm](https://registry.npmjs.org/es-module-lexer/2.3.2) |
| esbuild | 0.28.2 | Development | MIT | [npm](https://registry.npmjs.org/esbuild/0.28.2) |
| escalade | 3.2.0 | Development | MIT | [npm](https://registry.npmjs.org/escalade/3.2.0) |
| eslint-visitor-keys | 3.4.3 | Development | Apache-2.0 | [npm](https://registry.npmjs.org/eslint-visitor-keys/3.4.3) |
| espree | 9.6.1 | Development | BSD-2-Clause | [npm](https://registry.npmjs.org/espree/9.6.1) |
| estree-walker | 3.0.3 | Development | MIT | [npm](https://registry.npmjs.org/estree-walker/3.0.3) |
| expect-type | 1.4.0 | Development | Apache-2.0 | [npm](https://registry.npmjs.org/expect-type/1.4.0) |
| exponential-backoff | 3.1.3 | Development | Apache-2.0 | [npm](https://registry.npmjs.org/exponential-backoff/3.1.3) |
| fast-decode-uri-component | 1.0.1 | Runtime | MIT | [npm](https://registry.npmjs.org/fast-decode-uri-component/1.0.1) |
| fast-deep-equal | 3.1.3 | Runtime | MIT | [npm](https://registry.npmjs.org/fast-deep-equal/3.1.3) |
| fast-json-stringify | 7.0.1 | Runtime | MIT | [npm](https://registry.npmjs.org/fast-json-stringify/7.0.1) |
| fast-jwt | 6.3.3 | Runtime | Apache-2.0 | [npm](https://registry.npmjs.org/fast-jwt/6.3.3) |
| fast-querystring | 1.1.2 | Runtime | MIT | [npm](https://registry.npmjs.org/fast-querystring/1.1.2) |
| fast-uri | 3.1.8 | Runtime | BSD-3-Clause | [npm](https://registry.npmjs.org/fast-uri/3.1.8) |
| fast-uri | 4.2.1 | Runtime | BSD-3-Clause | [npm](https://registry.npmjs.org/fast-uri/4.2.1) |
| fastfall | 1.5.1 | Runtime | MIT | [npm](https://registry.npmjs.org/fastfall/1.5.1) |
| fastify-plugin | 6.0.0 | Runtime | MIT | [npm](https://registry.npmjs.org/fastify-plugin/6.0.0) |
| fastify | 5.12.5 | Direct runtime | MIT | [npm](https://registry.npmjs.org/fastify/5.12.5) |
| fastparallel | 2.4.1 | Runtime | ISC | [npm](https://registry.npmjs.org/fastparallel/2.4.1) |
| fastq | 1.20.3 | Runtime | ISC | [npm](https://registry.npmjs.org/fastq/1.20.3) |
| fastseries | 1.7.2 | Runtime | ISC | [npm](https://registry.npmjs.org/fastseries/1.7.2) |
| fdir | 6.5.0 | Development | MIT | [npm](https://registry.npmjs.org/fdir/6.5.0) |
| fetch-blob | 3.2.0 | Development | MIT | [npm](https://registry.npmjs.org/fetch-blob/3.2.0) |
| file-uri-to-path | 1.0.0 | Development | MIT | [npm](https://registry.npmjs.org/file-uri-to-path/1.0.0) |
| find-my-way | 9.9.0 | Runtime | MIT | [npm](https://registry.npmjs.org/find-my-way/9.9.0) |
| foreground-child | 3.3.1 | Development | ISC | [npm](https://registry.npmjs.org/foreground-child/3.3.1) |
| formdata-polyfill | 4.0.10 | Development | MIT | [npm](https://registry.npmjs.org/formdata-polyfill/4.0.10) |
| fs-extra | 11.2.0 | Development | MIT | [npm](https://registry.npmjs.org/fs-extra/11.2.0) |
| fs-minipass | 3.0.3 | Development | ISC | [npm](https://registry.npmjs.org/fs-minipass/3.0.3) |
| fsevents | 2.3.3 | Development | MIT | [npm](https://registry.npmjs.org/fsevents/2.3.3) |
| get-caller-file | 2.0.5 | Development | ISC | [npm](https://registry.npmjs.org/get-caller-file/2.0.5) |
| glob | 10.5.0 | Development | ISC | [npm](https://registry.npmjs.org/glob/10.5.0) |
| glob | 11.1.0 | Development | BlueOak-1.0.0 | [npm](https://registry.npmjs.org/glob/11.1.0) |
| graceful-fs | 4.2.11 | Development | ISC | [npm](https://registry.npmjs.org/graceful-fs/4.2.11) |
| htmlparser2 | 9.1.0 | Development | MIT | [npm](https://registry.npmjs.org/htmlparser2/9.1.0) |
| http-cache-semantics | 4.2.0 | Development | BSD-2-Clause | [npm](https://registry.npmjs.org/http-cache-semantics/4.2.0) |
| http-proxy-agent | 5.0.0 | Runtime | MIT | [npm](https://registry.npmjs.org/http-proxy-agent/5.0.0) |
| http-proxy-agent | 7.0.2 | Development | MIT | [npm](https://registry.npmjs.org/http-proxy-agent/7.0.2) |
| https-proxy-agent | 5.0.1 | Runtime | MIT | [npm](https://registry.npmjs.org/https-proxy-agent/5.0.1) |
| https-proxy-agent | 7.0.6 | Development | MIT | [npm](https://registry.npmjs.org/https-proxy-agent/7.0.6) |
| httpx | 2.3.3 | Runtime | MIT | [npm](https://registry.npmjs.org/httpx/2.3.3) |
| iconv-lite | 0.6.3 | Development | MIT | [npm](https://registry.npmjs.org/iconv-lite/0.6.3) |
| image2uri | 2.1.2 | Development | MIT | [npm](https://registry.npmjs.org/image2uri/2.1.2) |
| imurmurhash | 0.1.4 | Development | MIT | [npm](https://registry.npmjs.org/imurmurhash/0.1.4) |
| inherits | 2.0.4 | Runtime | ISC | [npm](https://registry.npmjs.org/inherits/2.0.4) |
| ini | 1.3.8 | Runtime | ISC | [npm](https://registry.npmjs.org/ini/1.3.8) |
| ini | 5.0.0 | Development | ISC | [npm](https://registry.npmjs.org/ini/5.0.0) |
| ip-address | 10.7.2 | Runtime | MIT | [npm](https://registry.npmjs.org/ip-address/10.7.2) |
| ipaddr.js | 2.5.0 | Runtime | MIT | [npm](https://registry.npmjs.org/ipaddr.js/2.5.0) |
| is-fullwidth-code-point | 3.0.0 | Development | MIT | [npm](https://registry.npmjs.org/is-fullwidth-code-point/3.0.0) |
| isexe | 2.0.0 | Development | ISC | [npm](https://registry.npmjs.org/isexe/2.0.0) |
| isexe | 3.1.5 | Development | BlueOak-1.0.0 | [npm](https://registry.npmjs.org/isexe/3.1.5) |
| jackspeak | 3.4.3 | Development | BlueOak-1.0.0 | [npm](https://registry.npmjs.org/jackspeak/3.4.3) |
| jackspeak | 4.2.3 | Development | BlueOak-1.0.0 | [npm](https://registry.npmjs.org/jackspeak/4.2.3) |
| jiti | 2.7.0 | Development | MIT | [npm](https://registry.npmjs.org/jiti/2.7.0) |
| json-schema-ref-resolver | 3.0.0 | Runtime | MIT | [npm](https://registry.npmjs.org/json-schema-ref-resolver/3.0.0) |
| json-schema-traverse | 1.0.0 | Runtime | MIT | [npm](https://registry.npmjs.org/json-schema-traverse/1.0.0) |
| jsonc-eslint-parser | 2.4.2 | Development | MIT | [npm](https://registry.npmjs.org/jsonc-eslint-parser/2.4.2) |
| jsonfile | 6.2.1 | Development | MIT | [npm](https://registry.npmjs.org/jsonfile/6.2.1) |
| kitx | 2.2.0 | Runtime | MIT | [npm](https://registry.npmjs.org/kitx/2.2.0) |
| light-my-request | 6.6.0 | Runtime | BSD-3-Clause | [npm](https://registry.npmjs.org/light-my-request/6.6.0) |
| lightningcss-android-arm64 | 1.33.0 | Development | MPL-2.0 | [npm](https://registry.npmjs.org/lightningcss-android-arm64/1.33.0) |
| lightningcss-darwin-arm64 | 1.33.0 | Development | MPL-2.0 | [npm](https://registry.npmjs.org/lightningcss-darwin-arm64/1.33.0) |
| lightningcss-darwin-x64 | 1.33.0 | Development | MPL-2.0 | [npm](https://registry.npmjs.org/lightningcss-darwin-x64/1.33.0) |
| lightningcss-freebsd-x64 | 1.33.0 | Development | MPL-2.0 | [npm](https://registry.npmjs.org/lightningcss-freebsd-x64/1.33.0) |
| lightningcss-linux-arm-gnueabihf | 1.33.0 | Development | MPL-2.0 | [npm](https://registry.npmjs.org/lightningcss-linux-arm-gnueabihf/1.33.0) |
| lightningcss-linux-arm64-gnu | 1.33.0 | Development | MPL-2.0 | [npm](https://registry.npmjs.org/lightningcss-linux-arm64-gnu/1.33.0) |
| lightningcss-linux-arm64-musl | 1.33.0 | Development | MPL-2.0 | [npm](https://registry.npmjs.org/lightningcss-linux-arm64-musl/1.33.0) |
| lightningcss-linux-x64-gnu | 1.33.0 | Development | MPL-2.0 | [npm](https://registry.npmjs.org/lightningcss-linux-x64-gnu/1.33.0) |
| lightningcss-linux-x64-musl | 1.33.0 | Development | MPL-2.0 | [npm](https://registry.npmjs.org/lightningcss-linux-x64-musl/1.33.0) |
| lightningcss-win32-arm64-msvc | 1.33.0 | Development | MPL-2.0 | [npm](https://registry.npmjs.org/lightningcss-win32-arm64-msvc/1.33.0) |
| lightningcss-win32-x64-msvc | 1.33.0 | Development | MPL-2.0 | [npm](https://registry.npmjs.org/lightningcss-win32-x64-msvc/1.33.0) |
| lightningcss | 1.33.0 | Development | MPL-2.0 | [npm](https://registry.npmjs.org/lightningcss/1.33.0) |
| lines-and-columns | 1.2.4 | Development | MIT | [npm](https://registry.npmjs.org/lines-and-columns/1.2.4) |
| lodash.merge | 4.6.2 | Development | MIT | [npm](https://registry.npmjs.org/lodash.merge/4.6.2) |
| lodash | 4.18.1 | Runtime | MIT | [npm](https://registry.npmjs.org/lodash/4.18.1) |
| lru-cache | 10.4.3 | Development | ISC | [npm](https://registry.npmjs.org/lru-cache/10.4.3) |
| lru-cache | 11.5.3 | Development | BlueOak-1.0.0 | [npm](https://registry.npmjs.org/lru-cache/11.5.3) |
| magic-string | 0.30.21 | Development | MIT | [npm](https://registry.npmjs.org/magic-string/0.30.21) |
| make-fetch-happen | 14.0.3 | Development | ISC | [npm](https://registry.npmjs.org/make-fetch-happen/14.0.3) |
| mdn-data | 2.0.28 | Development | CC0-1.0 | [npm](https://registry.npmjs.org/mdn-data/2.0.28) |
| mdn-data | 2.0.30 | Development | CC0-1.0 | [npm](https://registry.npmjs.org/mdn-data/2.0.30) |
| microbuffer | 1.0.0 | Development | MIT | [npm](https://registry.npmjs.org/microbuffer/1.0.0) |
| minimalistic-assert | 1.0.1 | Runtime | ISC | [npm](https://registry.npmjs.org/minimalistic-assert/1.0.1) |
| minimatch | 10.2.6 | Development | BlueOak-1.0.0 | [npm](https://registry.npmjs.org/minimatch/10.2.6) |
| minimatch | 9.0.9 | Development | ISC | [npm](https://registry.npmjs.org/minimatch/9.0.9) |
| minipass-collect | 2.0.1 | Development | ISC | [npm](https://registry.npmjs.org/minipass-collect/2.0.1) |
| minipass-fetch | 4.0.1 | Development | MIT | [npm](https://registry.npmjs.org/minipass-fetch/4.0.1) |
| minipass-flush | 1.0.7 | Development | BlueOak-1.0.0 | [npm](https://registry.npmjs.org/minipass-flush/1.0.7) |
| minipass-pipeline | 1.2.4 | Development | ISC | [npm](https://registry.npmjs.org/minipass-pipeline/1.2.4) |
| minipass-sized | 1.0.3 | Development | ISC | [npm](https://registry.npmjs.org/minipass-sized/1.0.3) |
| minipass | 3.3.6 | Development | ISC | [npm](https://registry.npmjs.org/minipass/3.3.6) |
| minipass | 7.1.3 | Development | BlueOak-1.0.0 | [npm](https://registry.npmjs.org/minipass/7.1.3) |
| minizlib | 3.1.0 | Development | MIT | [npm](https://registry.npmjs.org/minizlib/3.1.0) |
| mnemonist | 0.40.5 | Runtime | MIT | [npm](https://registry.npmjs.org/mnemonist/0.40.5) |
| moment-timezone | 0.5.48 | Runtime | MIT | [npm](https://registry.npmjs.org/moment-timezone/0.5.48) |
| moment | 2.31.0 | Runtime | MIT | [npm](https://registry.npmjs.org/moment/2.31.0) |
| ms | 2.1.3 | Runtime | MIT | [npm](https://registry.npmjs.org/ms/2.1.3) |
| mz | 2.7.0 | Development | MIT | [npm](https://registry.npmjs.org/mz/2.7.0) |
| nan | 2.29.0 | Development | MIT | [npm](https://registry.npmjs.org/nan/2.29.0) |
| nanoid | 3.3.19 | Development | MIT | [npm](https://registry.npmjs.org/nanoid/3.3.19) |
| negotiator | 1.1.0 | Development | MIT | [npm](https://registry.npmjs.org/negotiator/1.1.0) |
| node-addon-api | 8.9.2 | Runtime | MIT | [npm](https://registry.npmjs.org/node-addon-api/8.9.2) |
| node-domexception | 1.0.0 | Development | MIT | [npm](https://registry.npmjs.org/node-domexception/1.0.0) |
| node-fetch | 3.3.2 | Development | MIT | [npm](https://registry.npmjs.org/node-fetch/3.3.2) |
| node-gyp | 11.5.0 | Development | MIT | [npm](https://registry.npmjs.org/node-gyp/11.5.0) |
| nopt | 8.1.0 | Development | ISC | [npm](https://registry.npmjs.org/nopt/8.1.0) |
| nth-check | 2.1.1 | Development | BSD-2-Clause | [npm](https://registry.npmjs.org/nth-check/2.1.1) |
| nunjucks | 3.2.4 | Development | BSD-2-Clause | [npm](https://registry.npmjs.org/nunjucks/3.2.4) |
| object-assign | 4.1.1 | Development | MIT | [npm](https://registry.npmjs.org/object-assign/4.1.1) |
| obliterator | 2.0.5 | Runtime | MIT | [npm](https://registry.npmjs.org/obliterator/2.0.5) |
| obug | 2.2.1 | Development | MIT | [npm](https://registry.npmjs.org/obug/2.2.1) |
| on-exit-leak-free | 2.1.2 | Runtime | MIT | [npm](https://registry.npmjs.org/on-exit-leak-free/2.1.2) |
| once | 1.4.0 | Runtime | ISC | [npm](https://registry.npmjs.org/once/1.4.0) |
| p-map | 7.0.8 | Development | MIT | [npm](https://registry.npmjs.org/p-map/7.0.8) |
| package-json-from-dist | 1.0.1 | Development | BlueOak-1.0.0 | [npm](https://registry.npmjs.org/package-json-from-dist/1.0.1) |
| pako | 1.0.11 | Development | (MIT AND Zlib) | [npm](https://registry.npmjs.org/pako/1.0.11) |
| parse5-htmlparser2-tree-adapter | 7.1.0 | Development | MIT | [npm](https://registry.npmjs.org/parse5-htmlparser2-tree-adapter/7.1.0) |
| parse5-parser-stream | 7.1.2 | Development | MIT | [npm](https://registry.npmjs.org/parse5-parser-stream/7.1.2) |
| parse5 | 7.3.0 | Development | MIT | [npm](https://registry.npmjs.org/parse5/7.3.0) |
| path-key | 3.1.1 | Development | MIT | [npm](https://registry.npmjs.org/path-key/3.1.1) |
| path-scurry | 1.11.1 | Development | BlueOak-1.0.0 | [npm](https://registry.npmjs.org/path-scurry/1.11.1) |
| path-scurry | 2.0.2 | Development | BlueOak-1.0.0 | [npm](https://registry.npmjs.org/path-scurry/2.0.2) |
| pathe | 2.0.3 | Development | MIT | [npm](https://registry.npmjs.org/pathe/2.0.3) |
| picocolors | 1.1.1 | Development | ISC | [npm](https://registry.npmjs.org/picocolors/1.1.1) |
| picomatch | 4.0.7 | Development | MIT | [npm](https://registry.npmjs.org/picomatch/4.0.7) |
| pino-abstract-transport | 3.0.0 | Runtime | MIT | [npm](https://registry.npmjs.org/pino-abstract-transport/3.0.0) |
| pino-std-serializers | 7.1.0 | Runtime | MIT | [npm](https://registry.npmjs.org/pino-std-serializers/7.1.0) |
| pino | 10.3.1 | Runtime | MIT | [npm](https://registry.npmjs.org/pino/10.3.1) |
| pirates | 4.0.7 | Development | MIT | [npm](https://registry.npmjs.org/pirates/4.0.7) |
| postcss | 8.5.28 | Development | MIT | [npm](https://registry.npmjs.org/postcss/8.5.28) |
| proc-log | 5.0.0 | Development | ISC | [npm](https://registry.npmjs.org/proc-log/5.0.0) |
| process-warning | 4.0.1 | Runtime | MIT | [npm](https://registry.npmjs.org/process-warning/4.0.1) |
| process-warning | 5.1.0 | Runtime | MIT | [npm](https://registry.npmjs.org/process-warning/5.1.0) |
| promise-retry | 2.0.1 | Development | MIT | [npm](https://registry.npmjs.org/promise-retry/2.0.1) |
| quick-format-unescaped | 4.0.4 | Runtime | MIT | [npm](https://registry.npmjs.org/quick-format-unescaped/4.0.4) |
| readable-stream | 3.6.2 | Runtime | MIT | [npm](https://registry.npmjs.org/readable-stream/3.6.2) |
| real-require | 0.2.0 | Runtime | MIT | [npm](https://registry.npmjs.org/real-require/0.2.0) |
| real-require | 1.0.0 | Runtime | MIT | [npm](https://registry.npmjs.org/real-require/1.0.0) |
| require-directory | 2.1.1 | Development | MIT | [npm](https://registry.npmjs.org/require-directory/2.1.1) |
| require-from-string | 2.0.2 | Runtime | MIT | [npm](https://registry.npmjs.org/require-from-string/2.0.2) |
| ret | 0.5.0 | Runtime | MIT | [npm](https://registry.npmjs.org/ret/0.5.0) |
| retry | 0.12.0 | Development | MIT | [npm](https://registry.npmjs.org/retry/0.12.0) |
| reusify | 1.1.0 | Runtime | MIT | [npm](https://registry.npmjs.org/reusify/1.1.0) |
| rfdc | 1.4.1 | Runtime | MIT | [npm](https://registry.npmjs.org/rfdc/1.4.1) |
| rolldown | 1.2.11 | Development | MIT | [npm](https://registry.npmjs.org/rolldown/1.2.11) |
| safe-buffer | 5.2.1 | Runtime | MIT | [npm](https://registry.npmjs.org/safe-buffer/5.2.1) |
| safe-regex2 | 5.1.1 | Runtime | MIT | [npm](https://registry.npmjs.org/safe-regex2/5.1.1) |
| safe-stable-stringify | 2.5.0 | Runtime | MIT | [npm](https://registry.npmjs.org/safe-stable-stringify/2.5.0) |
| safer-buffer | 2.1.2 | Runtime | MIT | [npm](https://registry.npmjs.org/safer-buffer/2.1.2) |
| sax | 1.6.1 | Runtime | BlueOak-1.0.0 | [npm](https://registry.npmjs.org/sax/1.6.1) |
| secure-json-parse | 4.1.0 | Runtime | BSD-3-Clause | [npm](https://registry.npmjs.org/secure-json-parse/4.1.0) |
| semver | 7.8.5 | Runtime | ISC | [npm](https://registry.npmjs.org/semver/7.8.5) |
| set-cookie-parser | 2.7.2 | Runtime | MIT | [npm](https://registry.npmjs.org/set-cookie-parser/2.7.2) |
| shebang-command | 2.0.0 | Development | MIT | [npm](https://registry.npmjs.org/shebang-command/2.0.0) |
| shebang-regex | 3.0.0 | Development | MIT | [npm](https://registry.npmjs.org/shebang-regex/3.0.0) |
| siginfo | 2.0.0 | Development | ISC | [npm](https://registry.npmjs.org/siginfo/2.0.0) |
| signal-exit | 4.1.0 | Development | ISC | [npm](https://registry.npmjs.org/signal-exit/4.1.0) |
| sm3 | 1.0.3 | Runtime | MIT | [npm](https://registry.npmjs.org/sm3/1.0.3) |
| smart-buffer | 4.2.0 | Runtime | MIT | [npm](https://registry.npmjs.org/smart-buffer/4.2.0) |
| socks-proxy-agent | 6.2.1 | Runtime | MIT | [npm](https://registry.npmjs.org/socks-proxy-agent/6.2.1) |
| socks-proxy-agent | 8.0.5 | Development | MIT | [npm](https://registry.npmjs.org/socks-proxy-agent/8.0.5) |
| socks | 2.8.10 | Runtime | MIT | [npm](https://registry.npmjs.org/socks/2.8.10) |
| sonic-boom | 4.2.1 | Runtime | MIT | [npm](https://registry.npmjs.org/sonic-boom/4.2.1) |
| source-map-js | 1.2.1 | Development | BSD-3-Clause | [npm](https://registry.npmjs.org/source-map-js/1.2.1) |
| split2 | 4.2.0 | Runtime | ISC | [npm](https://registry.npmjs.org/split2/4.2.0) |
| ssri | 12.0.0 | Development | ISC | [npm](https://registry.npmjs.org/ssri/12.0.0) |
| stackback | 0.0.2 | Development | MIT | [npm](https://registry.npmjs.org/stackback/0.0.2) |
| std-env | 4.2.0 | Development | MIT | [npm](https://registry.npmjs.org/std-env/4.2.0) |
| steed | 1.1.3 | Runtime | MIT | [npm](https://registry.npmjs.org/steed/1.1.3) |
| stream-shift | 1.0.3 | Runtime | MIT | [npm](https://registry.npmjs.org/stream-shift/1.0.3) |
| string-width | 4.2.3 | Development | MIT | [npm](https://registry.npmjs.org/string-width/4.2.3) |
| string-width | 5.1.2 | Development | MIT | [npm](https://registry.npmjs.org/string-width/5.1.2) |
| string_decoder | 1.3.0 | Runtime | MIT | [npm](https://registry.npmjs.org/string_decoder/1.3.0) |
| strip-ansi | 6.0.1 | Development | MIT | [npm](https://registry.npmjs.org/strip-ansi/6.0.1) |
| strip-ansi | 7.2.0 | Development | MIT | [npm](https://registry.npmjs.org/strip-ansi/7.2.0) |
| sucrase | 3.35.1 | Development | MIT | [npm](https://registry.npmjs.org/sucrase/3.35.1) |
| svg-path-commander | 2.3.3 | Development | MIT | [npm](https://registry.npmjs.org/svg-path-commander/2.3.3) |
| svg-pathdata | 7.2.0 | Development | MIT | [npm](https://registry.npmjs.org/svg-pathdata/7.2.0) |
| svg2ttf | 6.1.0 | Development | MIT | [npm](https://registry.npmjs.org/svg2ttf/6.1.0) |
| svgicons2svgfont | 15.0.1 | Development | MIT | [npm](https://registry.npmjs.org/svgicons2svgfont/15.0.1) |
| svgo | 3.3.5 | Development | MIT | [npm](https://registry.npmjs.org/svgo/3.3.5) |
| svgpath | 2.6.0 | Development | MIT | [npm](https://registry.npmjs.org/svgpath/2.6.0) |
| svgtofont | 6.5.3 | Development | MIT | [npm](https://registry.npmjs.org/svgtofont/6.5.3) |
| tar | 7.5.22 | Development | BlueOak-1.0.0 | [npm](https://registry.npmjs.org/tar/7.5.22) |
| thenify-all | 1.6.0 | Development | MIT | [npm](https://registry.npmjs.org/thenify-all/1.6.0) |
| thenify | 3.3.1 | Development | MIT | [npm](https://registry.npmjs.org/thenify/3.3.1) |
| thread-stream | 4.2.0 | Runtime | MIT | [npm](https://registry.npmjs.org/thread-stream/4.2.0) |
| tinybench | 2.9.0 | Development | MIT | [npm](https://registry.npmjs.org/tinybench/2.9.0) |
| tinyexec | 1.3.1 | Development | MIT | [npm](https://registry.npmjs.org/tinyexec/1.3.1) |
| tinyglobby | 0.2.17 | Development | MIT | [npm](https://registry.npmjs.org/tinyglobby/0.2.17) |
| tinyrainbow | 3.1.1 | Development | MIT | [npm](https://registry.npmjs.org/tinyrainbow/3.1.1) |
| toad-cache | 3.7.4 | Runtime | MIT | [npm](https://registry.npmjs.org/toad-cache/3.7.4) |
| toml-eslint-parser | 0.10.1 | Development | MIT | [npm](https://registry.npmjs.org/toml-eslint-parser/0.10.1) |
| transformation-matrix | 3.1.0 | Development | MIT | [npm](https://registry.npmjs.org/transformation-matrix/3.1.0) |
| ts-interface-checker | 0.1.13 | Development | Apache-2.0 | [npm](https://registry.npmjs.org/ts-interface-checker/0.1.13) |
| tsx | 4.23.1 | Direct development | MIT | [npm](https://registry.npmjs.org/tsx/4.23.1) |
| ttf2eot | 3.1.0 | Development | MIT | [npm](https://registry.npmjs.org/ttf2eot/3.1.0) |
| ttf2woff2 | 8.0.1 | Development | MIT | [npm](https://registry.npmjs.org/ttf2woff2/8.0.1) |
| ttf2woff | 3.0.0 | Development | MIT | [npm](https://registry.npmjs.org/ttf2woff/3.0.0) |
| typescript | 7.0.2 | Direct development | Apache-2.0 | [npm](https://registry.npmjs.org/typescript/7.0.2) |
| undici-types | 6.21.0 | Runtime | MIT | [npm](https://registry.npmjs.org/undici-types/6.21.0) |
| undici-types | 7.18.2 | Runtime | MIT | [npm](https://registry.npmjs.org/undici-types/7.18.2) |
| undici | 6.29.0 | Development | MIT | [npm](https://registry.npmjs.org/undici/6.29.0) |
| unique-filename | 4.0.0 | Development | ISC | [npm](https://registry.npmjs.org/unique-filename/4.0.0) |
| unique-slug | 5.0.0 | Development | ISC | [npm](https://registry.npmjs.org/unique-slug/5.0.0) |
| universalify | 2.0.1 | Development | MIT | [npm](https://registry.npmjs.org/universalify/2.0.1) |
| util-deprecate | 1.0.2 | Runtime | MIT | [npm](https://registry.npmjs.org/util-deprecate/1.0.2) |
| vite | 8.3.1 | Development | MIT | [npm](https://registry.npmjs.org/vite/8.3.1) |
| vitest | 4.1.11 | Direct development | MIT | [npm](https://registry.npmjs.org/vitest/4.1.11) |
| web-streams-polyfill | 3.3.3 | Development | MIT | [npm](https://registry.npmjs.org/web-streams-polyfill/3.3.3) |
| whatwg-encoding | 3.1.1 | Development | MIT | [npm](https://registry.npmjs.org/whatwg-encoding/3.1.1) |
| whatwg-mimetype | 4.0.0 | Development | MIT | [npm](https://registry.npmjs.org/whatwg-mimetype/4.0.0) |
| which | 2.0.2 | Development | ISC | [npm](https://registry.npmjs.org/which/2.0.2) |
| which | 5.0.0 | Development | ISC | [npm](https://registry.npmjs.org/which/5.0.0) |
| why-is-node-running | 2.3.0 | Development | MIT | [npm](https://registry.npmjs.org/why-is-node-running/2.3.0) |
| wrap-ansi | 7.0.0 | Development | MIT | [npm](https://registry.npmjs.org/wrap-ansi/7.0.0) |
| wrap-ansi | 8.1.0 | Development | MIT | [npm](https://registry.npmjs.org/wrap-ansi/8.1.0) |
| wrappy | 1.0.2 | Runtime | ISC | [npm](https://registry.npmjs.org/wrappy/1.0.2) |
| ws | 8.21.1 | Direct runtime | MIT | [npm](https://registry.npmjs.org/ws/8.21.1) |
| xml2js | 0.6.2 | Runtime | MIT | [npm](https://registry.npmjs.org/xml2js/0.6.2) |
| xmlbuilder | 11.0.1 | Runtime | MIT | [npm](https://registry.npmjs.org/xmlbuilder/11.0.1) |
| xtend | 4.0.2 | Runtime | MIT | [npm](https://registry.npmjs.org/xtend/4.0.2) |
| y18n | 5.0.8 | Development | ISC | [npm](https://registry.npmjs.org/y18n/5.0.8) |
| yallist | 4.0.0 | Development | ISC | [npm](https://registry.npmjs.org/yallist/4.0.0) |
| yallist | 5.0.0 | Development | BlueOak-1.0.0 | [npm](https://registry.npmjs.org/yallist/5.0.0) |
| yaml-eslint-parser | 1.3.2 | Development | MIT | [npm](https://registry.npmjs.org/yaml-eslint-parser/1.3.2) |
| yaml | 2.9.1 | Development | ISC | [npm](https://registry.npmjs.org/yaml/2.9.1) |
| yargs-parser | 21.1.1 | Development | ISC | [npm](https://registry.npmjs.org/yargs-parser/21.1.1) |
| yargs | 17.7.3 | Development | MIT | [npm](https://registry.npmjs.org/yargs/17.7.3) |
| yerror | 8.0.0 | Development | MIT | [npm](https://registry.npmjs.org/yerror/8.0.0) |
| zod | 4.4.3 | Direct runtime | MIT | [npm](https://registry.npmjs.org/zod/4.4.3) |
