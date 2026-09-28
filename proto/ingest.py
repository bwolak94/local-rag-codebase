"""
proto/ingest.py
---------------
Stage 0 prototype — ingest experiment.

Runs a 2×3 experiment matrix (2 embedding models × 3 chunk sizes) over the
TypeScript fixture files in proto/fixtures/, indexing each configuration into
a separate LanceDB table under .proto_db/.

Usage (from repo root):
    python proto/ingest.py

Requirements: proto/requirements.txt
Ollama must be running at http://localhost:11434 with the target models pulled:
    ollama pull nomic-embed-text
    ollama pull bge-m3
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

PROTO_DIR = Path(__file__).parent.resolve()
REPO_ROOT = PROTO_DIR.parent.resolve()
FIXTURES_DIR = PROTO_DIR / "fixtures"
DB_DIR = REPO_ROOT / ".proto_db"
DB_CONFIG_FILE = PROTO_DIR / ".proto_db_config.json"

# ---------------------------------------------------------------------------
# Experiment matrix  (2 models × 3 chunk sizes = 6 configs)
# ---------------------------------------------------------------------------

CONFIGS: list[dict] = [
    {"model": "nomic-embed-text", "max_chars": 800,  "table": "nomic_embed_text_800"},
    {"model": "nomic-embed-text", "max_chars": 1500, "table": "nomic_embed_text_1500"},
    {"model": "nomic-embed-text", "max_chars": 2500, "table": "nomic_embed_text_2500"},
    {"model": "bge-m3",           "max_chars": 800,  "table": "bge_m3_800"},
    {"model": "bge-m3",           "max_chars": 1500, "table": "bge_m3_1500"},
    {"model": "bge-m3",           "max_chars": 2500, "table": "bge_m3_2500"},
]


def run_ingest() -> None:
    DB_DIR.mkdir(parents=True, exist_ok=True)
    successful_tables: list[str] = []

    for cfg in CONFIGS:
        model: str = cfg["model"]
        max_chars: int = cfg["max_chars"]
        table_name: str = cfg["table"]

        print(f"\n[ingest] config: model={model}  max_chars={max_chars}  table={table_name}")

        try:
            from llama_index.core import SimpleDirectoryReader, VectorStoreIndex
            from llama_index.core.node_parser import SentenceSplitter
            from llama_index.core import StorageContext
            from llama_index.embeddings.ollama import OllamaEmbedding
            from llama_index.vector_stores.lancedb import LanceDBVectorStore
            import lancedb

            print(f"[ingest]   Loading files from {FIXTURES_DIR} ...")
            reader = SimpleDirectoryReader(input_dir=str(FIXTURES_DIR))
            documents = reader.load_data()
            print(f"[ingest]   Loaded {len(documents)} document(s).")

            splitter = SentenceSplitter(chunk_size=max_chars, chunk_overlap=100)

            embed_model = OllamaEmbedding(
                model_name=model,
                base_url="http://localhost:11434",
            )

            db = lancedb.connect(str(DB_DIR))

            try:
                db.drop_table(table_name)
                print(f"[ingest]   Dropped existing table '{table_name}'.")
            except Exception:
                pass

            vector_store = LanceDBVectorStore(uri=str(DB_DIR), table_name=table_name)
            storage_context = StorageContext.from_defaults(vector_store=vector_store)

            print(f"[ingest]   Chunking and embedding (model={model}) ...")
            VectorStoreIndex.from_documents(
                documents,
                storage_context=storage_context,
                embed_model=embed_model,
                transformations=[splitter],
                show_progress=False,
            )

            tbl = db.open_table(table_name)
            n_chunks = tbl.count_rows()

            print(f"[ingest]   model={model}  max_chars={max_chars}  → {n_chunks} chunks indexed")
            successful_tables.append(table_name)

        except ImportError as exc:
            print(
                f"[ingest] ERROR — missing dependency: {exc}\n"
                f"         Run: pip install -r proto/requirements.txt",
                file=sys.stderr,
            )
            continue

        except Exception as exc:
            err_msg = str(exc).lower()
            if "connection refused" in err_msg or "connect" in err_msg:
                print(
                    f"[ingest] ERROR — cannot reach Ollama at http://localhost:11434\n"
                    f"         Ensure Ollama is running: ollama serve\n"
                    f"         And the model is pulled:  ollama pull {model}\n"
                    f"         Original error: {exc}",
                    file=sys.stderr,
                )
            else:
                print(
                    f"[ingest] ERROR — config model={model} max_chars={max_chars}: {exc}",
                    file=sys.stderr,
                )
            continue

    config_snapshot = {
        "configs": [cfg for cfg in CONFIGS if cfg["table"] in successful_tables],
        "db_dir": str(DB_DIR),
    }
    DB_CONFIG_FILE.write_text(json.dumps(config_snapshot, indent=2), encoding="utf-8")
    print(f"\n[ingest] Done. {len(successful_tables)}/{len(CONFIGS)} configs indexed.")
    print(f"[ingest] Config written to {DB_CONFIG_FILE}")


if __name__ == "__main__":
    run_ingest()
