# Contributing

[简体中文](CONTRIBUTING.zh-CN.md)

Use Node.js 24 and pnpm 11.19.0. Install with `pnpm install --frozen-lockfile`, then run `pnpm typecheck`, `pnpm build`, and `pnpm test`. Use a separate local data directory and synthetic test data.

Open an issue to discuss substantial behavior or contract changes. A pull request should explain the user-visible problem, the change, relevant validation, and any compatibility implications. Keep changes focused and add tests for meaningful behavior, especially authentication, accounting, authorization, and provider failure paths.

External services must remain unavailable when they are not configured. Do not add a success fallback that conceals missing SMS, model, or payment configuration. Test doubles belong in test fixtures. Do not contact real providers or create paid requests in automated tests.

Never submit credentials, application keys, setup links, databases, audio, transcript content, or real account/customer data. Keep build output and installed dependencies out of source changes. Document new environment variables with placeholder values and validate them at the configuration boundary.

Preserve third-party license headers and notices. When changing a dependency, update the lockfile and the applicable [third-party inventory](THIRD_PARTY_NOTICES.md); check any CSS, fonts, or other assets copied into builds. Contributions must be your own work or have compatible permission. Contributions intentionally submitted for inclusion are under Apache License 2.0 unless explicitly agreed otherwise, consistent with section 5 of [LICENSE](LICENSE). The [branding policy](TRADEMARKS.md) remains separate.

Report security vulnerabilities through [SECURITY.md](SECURITY.md), rather than a public issue or pull request.

## Source inventory

After reviewing new or changed files for private information and third-party rights, stage the intended source files with Git and run `node scripts/record-source.mjs`. Review and stage `public-source.json`, then run `pnpm verify`. Recording hashes does not replace human privacy or license review. Do not stage runtime data, local configuration or generated output.
