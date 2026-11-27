# Third-party notices

Daming directly reuses selected MIT-licensed modules. Source paths, versions and adaptations are recorded in [licenses/upstream-reuse.json](licenses/upstream-reuse.json).

- Agent Autoloop: Copyright (c) 2026 数字生命卡兹克. Event validation, cron, errors and cron tests are integrated into packages/source-protocol. See [LICENSE](packages/source-protocol/LICENSE).
- Lancer / pi-gui: Copyright (c) 2026 Matthew Lam. Session contracts are integrated into packages/session-contracts. See [LICENSE](packages/session-contracts/LICENSE) and the original [NOTICE](packages/session-contracts/NOTICE).
- The architecture checker adapts the TypeScript AST/resolution and ownership approach of Lancer scripts/check-renderer-boundary.mjs and scripts/check-host-boundary.mjs. See [LICENSE](scripts/LICENSE.lancer) and the source attribution in scripts/check-boundaries.mjs.
- DeepSeek Super-agent was studied for architecture only; no source was copied.

No third-party media, fonts, model credentials or user sessions are included. Installed TypeScript, Node type definitions and their transitive dependencies retain their own package licenses.
The license for Daming's original code has not been chosen by its creator. Third-party notices remain effective independently.

- Magpie: Copyright (c) 2026 yetone, MIT. The legacy `services/model-gateway-go/internal/stream` branch reuses selected Go SSE/bare-error parsing, Chat usage, protocol usage rendering and text protocol encoding; see [LICENSE.magpie](services/model-gateway-go/LICENSE.magpie). In addition, the user-approved full headless experience vendors the MIT-licensed `nogui` source closure into `services/damingd` (provider/account/routing/catalog/usage/plugin/background maintenance paths) with the upstream [LICENSE](services/damingd/LICENSE) and [THIRD_PARTY_NOTICES](services/damingd/THIRD_PARTY_NOTICES) retained. Daming builds this copy as its own headless gateway; Agent configuration files are not written automatically.
