# AWS SageMaker Deployment Scripts

This directory contains scripts for deploying cross-encoder reranking models to AWS SageMaker.

## Status: Experimental / Not Recommended for Production

Based on benchmarking results (see `docs/reranking-integration-results.md`):
- **Performance gain**: +1% accuracy (77% vs 76% baseline)
- **Latency cost**: 13x increase (15ms → 201ms)
- **AWS costs**: ~$0.50-1.00/hour for ml.g4dn.xlarge instance

**Recommendation**: Keep reranking disabled by default (`MEMORA_RERANK_ENABLED=false`). The modest accuracy improvement doesn't justify the latency and cost overhead.

## Files

### `deploy_sagemaker_reranker.ts`
TypeScript deployment script for SageMaker endpoints.

Usage:
```bash
npm run deploy:sagemaker -- \
  --role-arn arn:aws:iam::ACCOUNT:role/ROLE_NAME \
  --endpoint-name memora-bge-reranker \
  --region us-east-1 \
  --instance-type ml.g4dn.xlarge \
  --artifact-bucket YOUR_BUCKET \
  --model-data-url s3://YOUR_BUCKET/path/to/model.tar.gz
```

### `templates/bge_reranker/inference.py`
SageMaker inference handler for BGE reranker model (BAAI/bge-reranker-large).

## Cleanup

To delete SageMaker resources and stop billing:

```bash
# Delete endpoint
aws sagemaker delete-endpoint --endpoint-name memora-bge-reranker --region us-east-1

# Delete endpoint config
aws sagemaker delete-endpoint-config --endpoint-config-name memora-bge-reranker-config --region us-east-1

# Delete model
aws sagemaker delete-model --model-name memora-bge-reranker-model --region us-east-1
```

## Alternative: Local Reranking

For better latency without AWS costs, consider:
1. Local sentence-transformers cross-encoder
2. Lightweight re-scoring models
3. Query-dependent reranking (only when needed)

See `src/services/rerank.ts` for the local fallback reranker implementation.
