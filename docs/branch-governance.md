# Branch Governance — Minimal POC

Purpose
- Define a clear branching, tagging, and PR policy that preserves the Minimal POC on main while enabling feature work in isolation.
- Reduce merge risk by encoding invariants for main and documenting where full-featured code lives (archive/full-featured) and how to re-enable features safely (feature/* branches).

Scope and definitions
- Minimal POC: episodic write and lexical BM25 retrieval only; semantic, facts, packing, promotion, rerank remain disabled by config and not registered as tools on main.
- Full-featured code: semantic embeddings, facts, fusion/RRF, rerankers, promotion/packing, and higher-verbosity diagnostics.

Branch roles
- main (Minimal POC)
  - Invariants:
    - Only memory.write and memory.retrieve are registered tools.
    - Diagnostics kept minimal by default (see README Diagnostics gating).
    - Semantic/facts/packing/promotion/rerank code paths remain disabled by config and not wired into the Minimal API surface.
    - Unit tests must pass; integration tests may run locally (OpenSearch) as needed.
    - Signed commits (-s -S) required (see Commit & PR policy).
  - Allowed changes:
    - Bug fixes, refactors, test/tooling/docs improvements that do not re-enable non-core features or expand the MCP surface beyond the Minimal API.
    - Diagnostics gating and trace helpers are fine if quiet by default.
  - Not allowed:
    - Registering non-core tools on main (e.g., memory.promote, memory.write_if_salient, memory.retrieve_and_pack, memory.autopromote).
    - Enabling semantic/facts/rerank by default.

- archive/full-featured (read-only/immutable except for tag maintenance)
  - Contains the full-featured code path prior to slimdown.
  - Do not merge into main.
  - Only update if absolutely necessary to fix history references or to refresh tags; otherwise treat as frozen.

- feature/* (work branches)
  - Use for re-enabling specific feature areas (examples):
    - feature/re-enable-semantic
    - feature/facts-and-pack
    - feature/promotion
    - feature/rerank-osml
  - Rules for feature branches:
    - Keep changes scoped; prefer toggles config-first (YAML/env) and avoid affecting main defaults.
    - Update/extend tests in-branch; CI must pass.
    - Update docs/pr-notes.md to summarize operator impact and migration notes.

- hotfix/* (emergency fixes to main)
  - Use for remedial commits on main when urgent; keep scope minimal and adhere to main invariants.
  - After merge, consider backporting to applicable feature branches as needed.

Tags
- v-before-slimdown: commit immediately before the slimdown commit (full-featured reference).
- v-minimal-poc: the slimdown commit point (first Minimal POC reference).
- Maintenance:
  - Script: scripts/dev/recreate_safe_tags.sh can re-establish these tags against rewritten history and push them:
    - It locates or falls back to HEAD for v-minimal-poc, and locates pre-slimdown for v-before-slimdown.
    - Review script output before pushing (-f force-push is used).
  - Always push tags to origin after verification:
    - git push --no-verify -f origin v-before-slimdown
    - git push --no-verify -f origin v-minimal-poc

Commit & PR policy
- Every commit must be signed and GPG-signed:
  - git commit -s -S -m "subject: description"
- CI requirements:
  - Lint, build, unit tests: passing.
  - Integration tests: recommended locally against OpenSearch; ensure README and helper scripts remain accurate.
- Documentation:
  - For any behavioral or operator-facing change, update docs/pr-notes.md.
  - Keep README “Branch notice” accurate; do not advertise non-core tools on main.
  - If adding or changing branch/tag process, update this file (docs/branch-governance.md).
- Minimal POC invariants check before merging to main:
  - No new tool registrations beyond memory.write and memory.retrieve in src/routes/memory.ts.
  - config/retrieval.yaml defaults keep diagnostics quiet and advanced stages disabled.
  - Unit test counts stay healthy; any removed tests are justified (e.g., dead flags removal).
  - No accidental re-enable of semantic/facts/rerank in defaults.

Release hygiene
- Regular version tags (vX.Y.Z) apply only when main is green and Minimal POC invariants hold.
- The release workflow (.github/workflows/release.yml) is tag-driven; keep unit tests stable and passing.

Recommended GitHub branch protection (main)
- Require status checks to pass (CI job with unit tests, lint, build).
- Require signed commits.
- Require linear history (no merge commits), favor “Rebase and merge”.
- Restrict who can push; enforce PRs for changes to main.
- Optionally require CODEOWNERS review for src/routes/memory.ts, config/retrieval.yaml, README.md, docs/branch-governance.md, docs/pr-notes.md.

Merging flow examples
- Feature work → main:
  - Implement feature in feature/<name> with flags disabled by default; add tests.
  - Open PR targeting main only if no Minimal POC invariant is violated.
  - If feature cannot be made off-by-default, target a long-lived integration branch or keep it feature-only until ready.
- Diagnostics or dev tooling:
  - Safe to merge to main if defaults remain quiet and no Minimal API changes are introduced.
- Emergency fix:
  - hotfix/* → PR → main; verify invariants; follow up with documentation.

Checks (quick)
- src/routes/memory.ts: registered tools set minimal
- config/retrieval.yaml: diagnostics defaults off; absent removed flags; no semantic defaults enabled
- README: contains Branch notice and Branching model section
- docs/pr-notes.md: updated for noteworthy changes
- Tags v-before-slimdown and v-minimal-poc exist or can be recreated with scripts/dev/recreate_safe_tags.sh

References
- README — Branch notice and Branching model
- scripts/dev/recreate_safe_tags.sh — tag maintenance
- docs/pr-notes.md — operator-facing changes
