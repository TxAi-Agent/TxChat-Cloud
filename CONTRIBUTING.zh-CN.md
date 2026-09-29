# 参与贡献

[English](CONTRIBUTING.md)

使用 Node.js 24 与 pnpm 11.19.0，执行 `pnpm install --frozen-lockfile` 安装后，运行 `pnpm typecheck`、`pnpm build`、`pnpm test`。开发时使用独立的本地数据目录及合成测试数据。

重要行为或接口契约调整请先通过 Issue 说明。Pull Request 应描述用户可感知的问题、最终改动、相关验证和兼容性影响。保持范围集中，为认证、记账、授权及供应商失败处理等有意义的行为添加测试。

外部服务未配置时须保持不可用，不得增加掩盖短信、模型或支付缺配置的成功回退。测试替身应放在测试夹具中，自动化测试不得联系真实供应商或发起付费请求。

不要提交凭据、应用密钥、管理员设置链接、数据库、录音、转写正文或真实账号/客户数据。构建产物和安装后的依赖不应进入源码变更。新增环境变量应提供占位说明，并在配置边界校验。

保留第三方许可证头部与归属通知。更新依赖时同步锁文件及适用的[第三方清单](THIRD_PARTY_NOTICES.md)，检查会复制进构建产物的 CSS、字体及其他资源。贡献必须为本人有权提交的作品或取得兼容授权的内容。依照 [LICENSE](LICENSE) 第 5 条，有意提交纳入本项目的贡献采用 Apache License 2.0，另有明确约定的除外；[品牌规则](TRADEMARKS.md) 独立适用。

安全漏洞请依照 [SECURITY.zh-CN.md](SECURITY.zh-CN.md) 私密报告，不要公开发 Issue 或 Pull Request。

## 源码清单

新增或修改文件完成隐私与第三方权利审查后，先用 Git 暂存拟纳入的源码，执行 `node scripts/record-source.mjs`，再审查并暂存 `public-source.json`，运行 `pnpm verify`。哈希记录不能代替人工隐私或许可证审查。不要暂存运行数据、本地配置或生成输出。
