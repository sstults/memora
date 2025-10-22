Packing is one of the fastest levers to move a LongMem-style score from ~78% into the 90s, *without* changing retrieval or the base model. Below is a focused playbook to implement and A/B in Memora with reproducible configs.

---

# High-impact packing experiments

## 1) Answer-oriented packing (AOP)

**What:** Before packing, run a *cheap condense step* that rewrites the user turn into a minimal query (entities, time, constraints) and a *target-evidence schema* (what facts are needed).
**How it helps:** Prevents packing irrelevant history; sharpens what must be included.

**Config sketch**

```yaml
packing:
  precondense:
    enabled: true
    prompt: "Extract entities, time bounds, and the 3–7 facts needed to answer."
  strategy: rank_and_truncate
```

---

## 2) Hierarchical rolling summaries (HRS) with “fact keys”

**What:** Maintain tiered summaries:

* **Tier-0:** canonical *fact table* (key→value w/ source turn IDs)
* **Tier-1:** rolling dialogue summaries (per topic/thread)
* **Tier-2:** raw snippets (only top-k)

**How it helps:** For long contexts, the model sees compact *ground truths* first, then thread summaries, then small raw quotes only when needed.

**Config sketch**

```yaml
packing:
  layout:
    slots:
      - name: "fact_keys"       # Tier-0, highest priority
        budget_tokens: 2000
        source: "memora.fact_kv"
      - name: "thread_summaries" # Tier-1
        budget_tokens: 4000
        source: "memora.threads"
      - name: "quotes"           # Tier-2
        budget_tokens: 3000
        source: "retrieval.snippets"
  slot_order: ["fact_keys","thread_summaries","quotes"]
```

Implementation tip: build/refresh **fact_kv** during or after each turn (distill new facts + link to turn IDs). Pack these *first*.

---

## 3) Redundancy control (MMR/MinHash)

**What:** After ranking, run **MMR** (maximal marginal relevance) or **MinHash-based near-duplicate filter** to remove overlapping snippets.
**How it helps:** Frees 20–40% tokens in typical chat logs with repetitive content.

**Config sketch**

```yaml
packing:
  dedupe:
    method: "mmr"
    lambda: 0.75      # balance relevance vs novelty
    similarity: "cosine_e5"
    minhash_jaccard: 0.85
```

---

## 4) Extractive > abstractive, then *micro-abstractive*

**What:** Prefer **extractive sentence selection** (top-n sentences per doc) to stay faithful; if still too long, do ultra-short abstractive merges (“2–3 bullet summary, keep numbers & names”).
**How it helps:** Extractive maintains grounding; micro-abstractive preserves key details when squeezing.

**Config sketch**

```yaml
packing:
  compression:
    primary: "extractive_sentences"
    sentences_per_chunk: 2
    fallback: "llm_micro_summary"
    micro_summary_tokens: 80
    keep_entities_numbers: true
```

---

## 5) Role-aware, recency-aware scoring

**What:** Combine retrieval score, recency decay, and role weights (system > user > assistant > tool).
**How it helps:** Keeps instructions and user constraints sticky; avoids tool-spam.

**Scoring formula**

```
score = 0.55*retrieval + 0.25*recency + 0.20*salience
score *= role_weight(role)   # e.g., sys=1.25, user=1.1, tool=0.9
```

**Config sketch**

```yaml
packing:
  scoring:
    weights: {retrieval: 0.55, recency: 0.25, salience: 0.20}
    role_weights: {system: 1.25, user: 1.10, assistant: 1.0, tool: 0.9}
    recency_half_life_turns: 12
```

---

## 6) Budgeting with **reserved headroom**

**What:** Reserve fixed output headroom (e.g., 2–4k tokens) and a **hard floor** for Tier-0/Tier-1.
**How it helps:** Prevents answer truncation and catastrophic loss of facts when queries are long.

**Config sketch**

```yaml
packing:
  budget:
    total_tokens: 120000
    output_headroom: 4000
    floors:
      fact_keys: 1200
      thread_summaries: 2000
```

---

## 7) Query-conditioned slot reallocation

**What:** If the condense step predicts the question requires *long-range memory*, shift budget from quotes→summaries; if *short-range/tool* heavy, shift to latest turns.
**How it helps:** Adaptive packing matches task type.

**Config sketch**

```yaml
packing:
  adaptive:
    enabled: true
    detectors: ["needs_long_range","needs_numbers","needs_code"]
    reallocations:
      needs_long_range:
        from: "quotes"
        to: "thread_summaries"
        tokens: 1500
```

---

## 8) Tool-trace compaction

**What:** When tool outputs are verbose (JSON), store **schema-aware deltas** and only pack: inputs summary, outputs summary, *and* a pointer (turn ID) to full text if needed.
**How it helps:** Big win on agent runs; reduces noise.

---

## 9) Deterministic packing (for reproducibility)

* Fix random seeds in any sampling.
* Use stable sort keys `(rank, mmr_order, turn_id)`.
* Hash each packed unit; emit a **packing manifest** alongside the prompt.

**Pseudocode**

```ts
const RSEED=42;
rank(entries); mmr(entries, RSEED);
const manifest = entries.map(e => ({id:e.id, hash:sha1(e.text), slot:e.slot}));
```

Store the manifest with the benchmark record.

---

# Minimal code outline (packer core)

```ts
export function pack(request, cfg, stores): Packed {
  const goal = condense(request, cfg.precondense);              // AOP
  let C = gatherCandidates(goal, stores);                       // retrieval + memory
  C = score(C, cfg.scoring);                                    // relevance+recency+role
  C = dedupe(C, cfg.dedupe);                                    // MMR / MinHash
  C = compress(C, cfg.compression);                             // extractive → micro-abstractive
  const layout = allocate(C, cfg.layout, cfg.budget, goal);     // HRS + adaptive slots
  const manifest = fingerprint(layout);
  const prompt = render(layout, cfg.format);
  return {prompt, manifest, stats: tokenStats(prompt)};
}
```

---

# Experiment plan (simple, reproducible)

Run on the same fixed benchmark shard/seed.

| Exp ID | Change vs Baseline                        | Models                | Expectation |
| ------ | ----------------------------------------- | --------------------- | ----------- |
| A      | AOP (precondense) only                    | GPT-4o, Llama-3.1-70B | +2–4 pts    |
| B      | A + HRS (fact_keys + thread_summaries)    | both                  | +4–8 pts    |
| C      | B + MMR/MinHash dedupe                    | both                  | +1–3 pts    |
| D      | C + extractive→micro-abstractive fallback | both                  | +1–2 pts    |
| E      | D + adaptive slot reallocation            | both                  | +1–3 pts    |

**Target:** Baseline ~78% → B/C should push mid-80s; D/E commonly tip into **low-90s** on long-range QA.

---

# Model-specific knobs

**GPT-4o**

* Handles longer fused summaries well; allow slightly larger Tier-1.
* Use more aggressive dedupe (higher novelty threshold).
* Allow smaller output headroom if answers are short-form.

**Llama (e.g., 3.1-70B-Instruct)**

* Stricter instruction preamble (“Use only the packed facts.”).
* Prefer *more extractive* content; keep numbers/quotes verbatim.
* Keep summaries shorter; allocate more to Tier-0/Tier-2.

---

# Metrics to watch (per run)

* **Coverage@K (fact coverage):** % of gold facts present in packed prompt.
* **Info density:** facts-per-1k-tokens in packed memory.
* **Redundancy rate:** Jaccard > 0.85 duplicates dropped.
* **Answer quality:** EM/F1 from the benchmark.
* **Latency overhead:** extra ms from summarization/packing (budget it).

---

Maybe create a `config/packing.yaml` with A–E variants and a test harness script (`scripts/ablate_packing.ts`) that runs the benchmark shard across those configs and emits a CSV of results.
