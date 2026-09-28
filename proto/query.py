"""
proto/query.py
--------------
Stage 0 prototype — evaluation query experiment.

Loads all indexed LanceDB tables created by ingest.py, runs 30 questions
against each configuration, and computes Recall@5 and MRR to compare
embedding models and chunk sizes.

Usage (from repo root):
    python proto/query.py

Must be run AFTER proto/ingest.py has completed successfully.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

PROTO_DIR = Path(__file__).parent.resolve()
REPO_ROOT = PROTO_DIR.parent.resolve()
DB_CONFIG_FILE = PROTO_DIR / ".proto_db_config.json"

# ---------------------------------------------------------------------------
# Question bank — 30 questions (12 identifier + 18 semantic)
# ---------------------------------------------------------------------------

QUESTIONS: list[dict[str, Any]] = [
    # Identifier lookups (12)
    {"q": "Where is InvoiceService defined?",                                    "tag": "identifier", "expected_file": "invoice.service.ts"},
    {"q": "What does TaxCalculator.calculate do?",                               "tag": "identifier", "expected_file": "tax-calculator.ts"},
    {"q": "Show me the TokenService.verify implementation",                      "tag": "identifier", "expected_file": "token.service.ts"},
    {"q": "What interface does Invoice use?",                                    "tag": "identifier", "expected_file": "types.ts"},
    {"q": "Where is getRate defined?",                                           "tag": "identifier", "expected_file": "tax-calculator.ts"},
    {"q": "What does TokenService.refresh return?",                              "tag": "identifier", "expected_file": "token.service.ts"},
    {"q": "Show me InvoiceService.cancel",                                       "tag": "identifier", "expected_file": "invoice.service.ts"},
    {"q": "What fields does InvoiceItem have?",                                  "tag": "identifier", "expected_file": "types.ts"},
    {"q": "Where is TokenPayload defined?",                                      "tag": "identifier", "expected_file": "types.ts"},
    {"q": "What does InvoiceService.getById do?",                                "tag": "identifier", "expected_file": "invoice.service.ts"},
    {"q": "Show me TaxRate interface",                                           "tag": "identifier", "expected_file": "types.ts"},
    {"q": "Where is TaxCalculator.getRate used?",                                "tag": "identifier", "expected_file": "tax-calculator.ts"},
    # Semantic questions (18)
    {"q": "How does invoice creation work?",                                     "tag": "semantic",    "expected_file": "invoice.service.ts"},
    {"q": "How is tax calculated for an invoice?",                               "tag": "semantic",    "expected_file": "tax-calculator.ts"},
    {"q": "How does token authentication work?",                                 "tag": "semantic",    "expected_file": "token.service.ts"},
    {"q": "What happens when an invoice is cancelled?",                          "tag": "semantic",    "expected_file": "invoice.service.ts"},
    {"q": "How are invoice items structured?",                                   "tag": "semantic",    "expected_file": "types.ts"},
    {"q": "How does token refresh work?",                                        "tag": "semantic",    "expected_file": "token.service.ts"},
    {"q": "What is the relationship between InvoiceService and TaxCalculator?",  "tag": "semantic",    "expected_file": "invoice.service.ts"},
    {"q": "How are tax rates determined by region?",                             "tag": "semantic",    "expected_file": "tax-calculator.ts"},
    {"q": "How is token expiry handled?",                                        "tag": "semantic",    "expected_file": "token.service.ts"},
    {"q": "What data does an invoice contain?",                                  "tag": "semantic",    "expected_file": "types.ts"},
    {"q": "How does the billing flow work end to end?",                          "tag": "semantic",    "expected_file": "invoice.service.ts"},
    {"q": "What methods does InvoiceService expose?",                            "tag": "semantic",    "expected_file": "invoice.service.ts"},
    {"q": "How are tokens signed?",                                              "tag": "semantic",    "expected_file": "token.service.ts"},
    {"q": "What is the token verification process?",                             "tag": "semantic",    "expected_file": "token.service.ts"},
    {"q": "How are tax rates stored?",                                           "tag": "semantic",    "expected_file": "tax-calculator.ts"},
    {"q": "What fields make up a TokenPayload?",                                 "tag": "semantic",    "expected_file": "types.ts"},
    {"q": "How are invoice items priced?",                                       "tag": "semantic",    "expected_file": "types.ts"},
    {"q": "What happens during token signing?",                                  "tag": "semantic",    "expected_file": "token.service.ts"},
]


def source_file_from_node(node: Any) -> str:
    try:
        meta = node.metadata or {}
        fname = meta.get("file_name") or meta.get("file_path") or ""
        return Path(fname).name
    except Exception:
        return ""


def recall_at_k(retrieved_files: list[str], expected: str, k: int = 5) -> float:
    if not expected:
        return -1.0
    return 1.0 if any(expected in f for f in retrieved_files[:k]) else 0.0


def reciprocal_rank(retrieved_files: list[str], expected: str) -> float:
    if not expected:
        return -1.0
    for rank, fname in enumerate(retrieved_files, start=1):
        if expected in fname:
            return 1.0 / rank
    return 0.0


def evaluate_config(cfg: dict[str, Any], db_dir: str) -> dict[str, Any]:
    model: str = cfg["model"]
    max_chars: int = cfg["max_chars"]
    table_name: str = cfg["table"]

    try:
        from llama_index.core import VectorStoreIndex
        from llama_index.core import StorageContext
        from llama_index.embeddings.ollama import OllamaEmbedding
        from llama_index.vector_stores.lancedb import LanceDBVectorStore

        embed_model = OllamaEmbedding(model_name=model, base_url="http://localhost:11434")
        vector_store = LanceDBVectorStore(uri=db_dir, table_name=table_name)
        index = VectorStoreIndex.from_vector_store(vector_store, embed_model=embed_model)
        retriever = index.as_retriever(similarity_top_k=5)

    except Exception as exc:
        print(f"[query] ERROR loading config model={model} table={table_name}: {exc}", file=sys.stderr)
        return {"model": model, "max_chars": max_chars, "table": table_name,
                "recall_at_5": None, "mrr": None, "error": str(exc)}

    recall_scores: list[float] = []
    rr_scores: list[float] = []
    n_skipped = 0

    for qdict in QUESTIONS:
        q_text: str = qdict["q"]
        expected_file: str = qdict.get("expected_file", "")

        try:
            nodes = retriever.retrieve(q_text)
            retrieved_files = [source_file_from_node(n) for n in nodes]

            r5 = recall_at_k(retrieved_files, expected_file)
            rr = reciprocal_rank(retrieved_files, expected_file)

            if r5 < 0 or rr < 0:
                n_skipped += 1
                continue

            recall_scores.append(r5)
            rr_scores.append(rr)

        except Exception as exc:
            print(f"[query]   WARN — question '{q_text[:50]}' failed: {exc}", file=sys.stderr)
            n_skipped += 1

    n_evaluated = len(recall_scores)
    recall_mean = sum(recall_scores) / n_evaluated if n_evaluated else 0.0
    mrr_mean = sum(rr_scores) / len(rr_scores) if rr_scores else 0.0

    print(
        f"[query]   model={model:<20}  max_chars={max_chars:<5}"
        f"  Recall@5={recall_mean:.3f}  MRR={mrr_mean:.3f}"
        f"  (n={n_evaluated}, skipped={n_skipped})"
    )

    return {
        "model": model, "max_chars": max_chars, "table": table_name,
        "recall_at_5": round(recall_mean, 4), "mrr": round(mrr_mean, 4),
        "n_evaluated": n_evaluated, "n_skipped": n_skipped,
    }


def run_query() -> None:
    if not DB_CONFIG_FILE.exists():
        print(
            "[query] ERROR — .proto_db_config.json not found.\n"
            "        Run proto/ingest.py first.",
            file=sys.stderr,
        )
        sys.exit(1)

    snapshot = json.loads(DB_CONFIG_FILE.read_text(encoding="utf-8"))
    configs: list[dict[str, Any]] = snapshot.get("configs", [])
    db_dir: str = snapshot.get("db_dir", str(REPO_ROOT / ".proto_db"))

    if not configs:
        print("[query] No configs found. Check that ingest.py completed without errors.", file=sys.stderr)
        sys.exit(1)

    print(f"[query] Evaluating {len(configs)} configs against {len(QUESTIONS)} questions each.")
    print(f"[query] DB dir: {db_dir}\n")

    try:
        from tabulate import tabulate
    except ImportError:
        print("[query] ERROR — tabulate not installed. Run: pip install tabulate", file=sys.stderr)
        sys.exit(1)

    all_results: list[dict[str, Any]] = []

    for cfg in configs:
        print(f"\n[query] --- config: model={cfg['model']}  max_chars={cfg['max_chars']}  table={cfg['table']} ---")
        all_results.append(evaluate_config(cfg, db_dir))

    print("\n\n" + "=" * 72)
    print("  EXPERIMENT RESULTS — 2×3 Embedding Model × Chunk Size Matrix")
    print("=" * 72)

    table_rows = []
    for r in all_results:
        recall = f"{r['recall_at_5']:.3f}" if r["recall_at_5"] is not None else "ERR"
        mrr    = f"{r['mrr']:.3f}"          if r["mrr"] is not None           else "ERR"
        table_rows.append([r["model"], r["max_chars"], recall, mrr, r.get("n_evaluated", "N/A")])

    print(tabulate(table_rows, headers=["Model", "max_chars", "Recall@5", "MRR", "N evaluated"], tablefmt="github"))

    nomic = [r for r in all_results if "nomic" in r.get("model", "") and r["recall_at_5"] is not None]
    bge   = [r for r in all_results if "bge"   in r.get("model", "") and r["recall_at_5"] is not None]

    if nomic:
        best = max(nomic, key=lambda x: x["recall_at_5"])
        print(f"\n[query] Best nomic-embed-text: max_chars={best['max_chars']}  Recall@5={best['recall_at_5']:.3f}  MRR={best['mrr']:.3f}")
    if bge:
        best = max(bge, key=lambda x: x["recall_at_5"])
        print(f"[query] Best bge-m3:           max_chars={best['max_chars']}  Recall@5={best['recall_at_5']:.3f}  MRR={best['mrr']:.3f}")

    print("\n[query] ADR-001: nomic-embed-text v1.5 selected as CPU-viable default.")
    print("[query] See eval/prototype-results.md — Decision section.")


if __name__ == "__main__":
    run_query()
