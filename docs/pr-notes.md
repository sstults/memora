# PR Notes — Diagnostics Gating and Minimal Trace Defaults

Summary
- Introduced diagnostics gating to reduce trace verbosity by default while keeping essential observability.
- Added configuration switches in config/retrieval.yaml and an environment override to enable full diagnostics when needed.
- Preserved a minimal set of always-on markers to support smokes and basic debugging without noise.
- Updated README with Diagnostics gating section and Troubleshooting guidance for vector dimension mismatches when re-enabling semantic.

Why
- Previous sessions increased trace verbosity (guard and fallback markers) to diagnose retrieval issues.
- With end-to-end smokes now green, we want to reduce noise and I/O while keeping a fast path to re-enable full diagnostics.

Changes
1) Centralized gating in traceWrite()
   - File: src/routes/memory.ts
   - Behavior:
     - Always-on minimal markers remain:
       - retrieve.begin, retrieve.end
       - episodic.body_once (first search body per process)
       - episodic.index.request / episodic.index.response / episodic.index.ok
     - All other markers are gated by diagnostics flags:
       - Guard traces: retrieve.guard.*, retrieve.pre_context, retrieve.post_context, retrieve.params, retrieve.diag, retrieve.ckpt, retrieve.finally
       - Fallback traces: episodic.fallback*
       - Request/Response: episodic.request, episodic.response

2) New retrieval.yaml diagnostics section (default off)
   - File: config/retrieval.yaml
   - Keys:
     diagnostics:
       enabled: false
       guard_traces: false
       fallback_traces: false
       request_response_traces: false

3) Environment override for urgent debugging
   - MEMORA_DIAGNOSTICS=1 forces diagnostics.enabled=true and enables all categories (guard, fallback, request/response).

4) Documentation
   - README.md: Added “Diagnostics gating” section including defaults, config switches, env override, and examples.
   - README.md: Added Troubleshooting notes for semantic vector dimension mismatches and remediation options.

Operator Guide
- Default (quiet):
  - No change required; minimal markers are written to outputs/memora/trace/retrieve.ndjson.
- Enable full diagnostics (temporary):
  - Env: export MEMORA_DIAGNOSTICS=1
  - Or YAML (persistent):
    diagnostics:
      enabled: true
      guard_traces: true
      fallback_traces: true
      request_response_traces: true
- Smoke script compatibility:
  - scripts/dev/run_smokes_and_tail.sh tails the always-on markers and selected gated markers. With defaults, you’ll still see:
    - episodic.index.(request|response|ok)
    - retrieve.(begin|end)
    - episodic.body_once (once per process)
  - To see full guard/fallback/request-response markers, enable diagnostics as above.

Semantic Gating Notes (unchanged in this PR)
- Semantic remains disabled by default on this branch (stages.semantic.enabled=false).
- If re-enabling semantic:
  - Ensure MEMORA_EMBED_DIM matches your semantic index dimension (e.g., 384 for MiniLM-L6).
  - Optionally set MEMORA_OS_AUTOFIX_VECTOR_DIM=true to auto-adjust knn_vector dimension during bootstrap.

Files Touched
- src/routes/memory.ts
  - Added diagnostics gating inside traceWrite(), keeping minimal markers always-on.
  - Env override MEMORA_DIAGNOSTICS=1 enables all gated categories.
- config/retrieval.yaml
  - Added diagnostics section with defaults off.
- README.md
  - Documented Diagnostics gating and Troubleshooting for semantic vector dimension mismatches.

Testing
- Unit tests: npm run test:unit (no behavior change to functional code paths; logging only).
- Integration/smokes (optional):
  - bash scripts/dev/run_smokes_and_tail.sh
  - Expect minimal markers by default; set MEMORA_DIAGNOSTICS=1 for full verbosity.

Upgrade/Migration
- No migration required. Existing environments continue to write minimal markers.
- For operators expecting previous verbosity, set diagnostics.* = true in YAML or MEMORA_DIAGNOSTICS=1 in env during investigations.

Commit Message Suggestion
diag: gate trace verbosity via YAML+env; keep minimal markers; docs + troubleshooting
