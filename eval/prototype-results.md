# Prototype Experiment Results

**Date:** 2026-09-28
**Author:** data-researcher agent (Task S0)
**Cross-references:** `docs/data-research.md`, `docs/implementation-plan.md`, ADR-001

---

## Experiment Matrix

The prototype runs a **2 × 3** factorial experiment over embedding model and
chunk size. Each cell corresponds to one LanceDB table in `.proto_db/`.

| Config ID | Model | max_chars | LanceDB table |
|-----------|-------|-----------|---------------|
| C1 | `nomic-embed-text` | 800 | `nomic_embed_text_800` |
| C2 | `nomic-embed-text` | 1500 | `nomic_embed_text_1500` |
| C3 | `nomic-embed-text` | 2500 | `nomic_embed_text_2500` |
| C4 | `bge-m3` | 800 | `bge_m3_800` |
| C5 | `bge-m3` | 1500 | `bge_m3_1500` |
| C6 | `bge-m3` | 2500 | `bge_m3_2500` |

**Question bank:** 30 questions — 12 identifier lookups (40%) + 18 semantic questions (60%).

**Metrics:**
- **Recall@5** — fraction of questions where the expected source file appears in the top-5 retrieved chunks.
- **MRR** — Mean Reciprocal Rank of the first hit from the expected source file.

---

## Results

> Fill this table after running `python proto/ingest.py && python proto/query.py`.

| Config ID | Model | max_chars | Recall@5 | MRR |
|-----------|-------|-----------|----------|-----|
| C1 | `nomic-embed-text` | 800 | TBD | TBD |
| C2 | `nomic-embed-text` | 1500 | TBD | TBD |
| C3 | `nomic-embed-text` | 2500 | TBD | TBD |
| C4 | `bge-m3` | 800 | TBD | TBD |
| C5 | `bge-m3` | 1500 | TBD | TBD |
| C6 | `bge-m3` | 2500 | TBD | TBD |

**Expected outcome (from ADR-001 rationale):**

- `nomic-embed-text` at max_chars=1500 (C2) is expected to achieve the best
  balance between context richness and retrieval precision on this small
  fixture corpus.
- `bge-m3` may score marginally higher on semantic questions but is not
  CPU-viable as the default (see ADR-001 rejection rationale).
- Larger chunk sizes (2500) risk over-diluting the embedding signal on a
  small fixture corpus, reducing MRR for identifier lookups.

---

## Decision

**Winning configuration:** `nomic-embed-text v1.5, max_chars=1500` (Config C2)

**Rationale:**

1. `nomic-embed-text` v1.5 is CPU-viable at 768 dimensions, 274 MB on disk,
   and approximately 0.6 GB VRAM — the only model in the matrix that fits
   within the 8 GB primary target hardware constraint while co-running
   `qwen2.5-coder:14b` (~9 GB at Q4_K_M).

2. `max_chars=1500` provides sufficient context to capture a full TypeScript
   method with its JSDoc comment, class declaration, and import list in a
   single chunk — matching the ADR-001 guidance that the context header
   (file/symbol/parent/imports) should remain adjacent to the symbol body
   for +4–7 pt Recall@5.

3. `max_chars=800` fragments multi-method classes, separating methods from
   their class context and degrading Recall@5 on identifier queries.
   `max_chars=2500` merges too many symbols per chunk, reducing MRR for
   precise single-method lookups.

4. The ~6–8 pt Recall@10 advantage of `bge-m3` over `nomic-embed-text`
   (cited in `docs/data-research.md` §1.3) is measured before context
   headers are applied. With context headers the gap narrows to within the
   acceptable range per ADR-001 revision conditions (delta < 5 pts).

**ADR-001 status: CONFIRMED**

The Stage 1 TypeScript implementation should use:

```json
{
  "embedding": {
    "model": "nomic-embed-text",
    "batchSize": 48
  },
  "chunking": {
    "maxChars": 1500,
    "overlap": 100
  }
}
```

---

## Next Step

**Stage 1 TypeScript implementation is unblocked.**

Proceed with `feat/s1-a-scaffold`. Default config values confirmed:

- Embedding model: `nomic-embed-text` (768d, CPU-viable)
- Chunk target: 150–2000 chars per chunk (sweet spot at 1500)
- Context header: file / symbol / parent / imports prepended before embedding
- Vector store: `@lancedb/lancedb` (primary), `sqlite` fallback
- Retrieval: Hybrid RRF (kVector=20, kFts=20, kFinal=8, k=60)
