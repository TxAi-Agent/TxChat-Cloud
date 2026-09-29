# Security policy

[简体中文](SECURITY.zh-CN.md)

Use the repository's [Security → Report a vulnerability](https://github.com/TxAi-Agent/TxChat-Cloud/security/advisories/new) form for private vulnerability reporting when GitHub private reporting is enabled. Do not describe an exploitable issue in a public issue, discussion, or pull request. If the private reporting control is unavailable, do not publish the sensitive details; wait for a private channel to be available.

Include the affected revision, component, expected and actual behavior, security impact, and a minimal reproduction using synthetic data. Omit credentials, cookies, tokens, administrator setup links, personal data, audio, and transcripts. Remove sensitive values from logs and screenshots. Disclose only what is needed to reproduce the issue.

Reports against the current source are the primary focus. No support window, response deadline, or security guarantee is implied for older snapshots. Dependencies and external providers have their own security policies; include their exact versions when relevant.

Keep application keys, provider secrets, and local data outside version control. The default listeners are local development settings. Missing external service configuration must not bypass authentication, billing checks, or provider errors. The administrator console is a separate privileged surface.

For ordinary bugs use the issue tracker. For contribution and licensing information see [CONTRIBUTING.md](CONTRIBUTING.md), [LICENSE](LICENSE), and [third-party notices](THIRD_PARTY_NOTICES.md).
