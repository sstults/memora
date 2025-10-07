#!/usr/bin/env python3
"""
LoCoMo references dumper

Purpose:
- Load a LoCoMo-style long-context QA dataset (from HuggingFace or a local JSON file)
- Normalize into a common reference schema and write to disk as JSON:
  [
    {
      "question": str,
      "answer": str,
      "question_id": str,
      "question_type": str | null,
      "context": str,
      "source": str | null,
      "abstention": bool | null
    },
    ...
  ]

Usage:
  python3 benchmarks/locomo_helpers/dump_references.py \
    --out outputs/locomo_cache/test.refs.json \
    [--dataset_id some/org_or_user/LoCoMo] \
    [--split test] \
    [--from_file path/to/local.json] \
    [--limit 100]

Notes:
- If --from_file is provided, dataset_id/split are ignored and data is loaded from the JSON file.
- Requires `pip install datasets` when using --dataset_id.
- The loader attempts to robustly infer field names across common schema variants.
"""

from __future__ import annotations
import argparse
import json
import os
import sys
from typing import Any, Dict, Iterable, List, Optional

def _first_present(d: Dict[str, Any], keys: Iterable[str]) -> Optional[Any]:
    for k in keys:
        if k in d and d[k] is not None:
            return d[k]
    return None

def _to_str(x: Any) -> str:
    if x is None:
        return ""
    if isinstance(x, (dict, list, tuple)):
        try:
            return json.dumps(x, ensure_ascii=False)
        except Exception:
            return str(x)
    return str(x)

def _normalize_example(ex: Dict[str, Any], idx: int, source_tag: Optional[str]) -> Dict[str, Any]:
    # Heuristics for common field names
    question = _first_present(ex, ["question", "query", "input", "prompt", "instruction"])
    answer = _first_present(ex, ["answer", "label", "ground_truth", "target", "output"])
    context = _first_present(ex, ["context", "document", "passage", "history", "long_context", "source_text", "docs"])
    qid = _first_present(ex, ["question_id", "qid", "id", "uid", "sample_id", "example_id"])
    qtype = _first_present(ex, ["question_type", "type", "category", "tag"])
    abstention = _first_present(ex, ["abstention", "is_abstention", "skip", "unanswerable"])

    if qid is None:
        qid = f"locomo-{idx}"

    return {
        "question": _to_str(question),
        "answer": _to_str(answer),
        "question_id": _to_str(qid),
        "question_type": _to_str(qtype) if qtype is not None else None,
        "context": _to_str(context),
        "source": source_tag,
        "abstention": bool(abstention) if isinstance(abstention, bool) else None,
    }

def _load_from_hf(dataset_id: str, split: str) -> List[Dict[str, Any]]:
    try:
        from datasets import load_dataset  # type: ignore
    except Exception as e:
        print("ERROR: datasets package is required for --dataset_id usage. pip install datasets", file=sys.stderr)
        raise

    ds = load_dataset(dataset_id, split=split)
    data: List[Dict[str, Any]] = []
    for i, ex in enumerate(ds):
        data.append(dict(ex))
    return data

def _load_from_file(p: str) -> List[Dict[str, Any]]:
    with open(p, "r", encoding="utf-8") as f:
        raw = json.load(f)
    # Accept either array or object with top-level "data"
    if isinstance(raw, dict) and "data" in raw and isinstance(raw["data"], list):
        return list(raw["data"])
    if isinstance(raw, list):
        return list(raw)
    # Try common predictions shape from MAB/LoCoMo style with {"data":[...],"meta":{...}}
    return [dict(raw)]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="Output path for normalized references JSON")
    ap.add_argument("--dataset_id", default=None, help="HF dataset id (e.g., some_org/LoCoMo)")
    ap.add_argument("--split", default="test", help="Dataset split (default: test)")
    ap.add_argument("--from_file", default=None, help="Load from local JSON file instead of HF dataset")
    ap.add_argument("--limit", type=int, default=None, help="Optional cap on number of items")
    args = ap.parse_args()

    if args.from_file:
        raw = _load_from_file(args.from_file)
        source_tag = os.path.basename(args.from_file)
    else:
        if not args.dataset_id:
            # Provide a helpful error directing the caller to supply dataset or file
            print("ERROR: Provide --dataset_id for HF dataset (requires `pip install datasets`) or --from_file for local JSON.", file=sys.stderr)
            sys.exit(2)
        raw = _load_from_hf(args.dataset_id, args.split)
        source_tag = f"{args.dataset_id}:{args.split}"

    if args.limit is not None and args.limit > 0:
        raw = raw[: min(args.limit, len(raw))]

    out_dir = os.path.dirname(args.out) or "."
    os.makedirs(out_dir, exist_ok=True)

    normalized: List[Dict[str, Any]] = []
    for i, ex in enumerate(raw):
        if not isinstance(ex, dict):
            ex = {"value": ex}
        normalized.append(_normalize_example(ex, i, source_tag))

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(normalized, f, ensure_ascii=False, indent=2)

    print(f"Wrote {len(normalized)} references to {args.out}")

if __name__ == "__main__":
    main()
