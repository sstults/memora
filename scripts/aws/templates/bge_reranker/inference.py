import json
import os
from typing import Any, Iterable, List, Tuple

import torch
from sentence_transformers import CrossEncoder

_MODEL: CrossEncoder | None = None


def model_fn(model_dir: str) -> CrossEncoder:
  """Load the CrossEncoder model once when the container starts."""
  global _MODEL
  if _MODEL is None:
    model_id = os.environ.get("HF_MODEL_ID", "BAAI/bge-reranker-large")
    max_length = int(os.environ.get("MAX_INPUT_LENGTH", "1024"))
    device = "cuda" if torch.cuda.is_available() else "cpu"
    _MODEL = CrossEncoder(model_id, max_length=max_length, device=device)
  return _MODEL


def input_fn(request_body: str, request_content_type: str) -> Tuple[str, List[str]]:
  if request_content_type and "json" not in request_content_type:
    raise ValueError(f"Unsupported content type: {request_content_type}")

  if not request_body:
    raise ValueError("Empty request body")

  payload = json.loads(request_body)

  if isinstance(payload, dict):
    if "inputs" in payload:
      payload = payload["inputs"]
    if isinstance(payload, dict) and "source_sentence" in payload and "sentences" in payload:
      query = str(payload["source_sentence"])
      passages = [str(p) for p in _normalize_iterable(payload["sentences"])]
      return query, passages
    if "query" in payload and "passages" in payload:
      query = str(payload["query"])
      passages = [str(p) for p in _normalize_iterable(payload["passages"])]
      return query, passages

  if isinstance(payload, list):
    # Expect [[query, passage], ...]
    pairs = [tuple(item) for item in payload]
    if not pairs:
      raise ValueError("Expected non-empty list of [query, passage] pairs")
    query = str(pairs[0][0])
    passages = [str(p[1]) for p in pairs]
    return query, passages

  raise ValueError("Unsupported payload format. Provide {inputs: {source_sentence, sentences}} or list of [query, passage].")


def predict_fn(data: Tuple[str, List[str]], model: CrossEncoder) -> List[float]:
  query, passages = data
  if not passages:
    return []
  pairs = [(query, passage) for passage in passages]
  scores = model.predict(pairs)
  if hasattr(scores, "tolist"):
    return scores.tolist()
  return [float(score) for score in scores]


def output_fn(prediction: List[float], accept: str) -> Tuple[str, str]:
  body = json.dumps({"scores": prediction})
  content_type = accept or "application/json"
  return body, content_type


def _normalize_iterable(value: Any) -> Iterable[Any]:
  if isinstance(value, list):
    return value
  if isinstance(value, tuple):
    return list(value)
  raise ValueError("Expected list of passages")
