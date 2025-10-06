#!/usr/bin/env python3
"""
Dump MemoryAgentBench references (questions/answers) from Hugging Face to JSON.
- Filters by split (default: Accurate_Retrieval)
- Filters by metadata.source with wildcard (e.g., 'longmemeval_s*')
- Outputs a JSON array to stdout:
  [
    {
      "question": str,
      "answer": str,
      "question_id": str,
      "question_type": str,
      "context": str
    },
    ...
  ]
"""
import sys
import json
import os
import fnmatch
from argparse import ArgumentParser

try:
  from datasets import load_dataset
except Exception as e:
  sys.stderr.write("ERROR: 'datasets' package is required. Install with: pip install datasets\n")
  raise

def load_references(hf_name: str, split: str, source_pattern: str):
  ds = load_dataset(hf_name, split=split, revision="main")
  refs = []
  for entry in ds:
    meta = entry.get("metadata") or {}
    src = meta.get("source", "")
    if not (isinstance(src, str) and fnmatch.fnmatch(src, source_pattern)):
      continue

    questions = entry.get("questions") or []
    answers = entry.get("answers") or []
    qids = (meta.get("question_ids") or [])
    qtypes = (meta.get("question_types") or [])
    context = entry.get("context") or ""

    n = min(len(questions), len(answers), len(qids), len(qtypes))
    if n == 0:
      continue

    for i in range(n):
      try:
        refs.append({
          "question": str(questions[i]),
          "answer": str(answers[i]),
          "question_id": str(qids[i]),
          "question_type": str(qtypes[i]),
          "context": str(context),
          "source": str(src),
          "abstention": ("_abs" in str(qids[i]))
        })
      except Exception:
        # Skip malformed items
        continue
  return refs

def main():
  ap = ArgumentParser()
  ap.add_argument("--huggingface_dataset_name", default="ai-hyz/MemoryAgentBench", help="HF dataset name")
  ap.add_argument("--split", default="Accurate_Retrieval", help="Dataset split to load")
  ap.add_argument("--source", default="longmemeval_s*", help="Wildcard pattern for metadata.source")
  ap.add_argument("--out", default="", help="Optional path to write JSON instead of stdout")
  args = ap.parse_args()

  refs = load_references(args.huggingface_dataset_name, args.split, args.source)
  payload = json.dumps(refs, ensure_ascii=False)
  if args.out:
    out_dir = os.path.dirname(args.out)
    if out_dir:
      os.makedirs(out_dir, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
      f.write(payload)
  else:
    sys.stdout.write(payload)

if __name__ == "__main__":
  main()
