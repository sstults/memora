# LongMemEval Aggregates

- LLM latency (ms): count=100, mean=0.000, p50=0.000, p95=0.000
- Tokens In: count=100, sum=0, mean=0.000, p50=0.000, p95=0.000
- Tokens Out: count=100, sum=0, mean=0.000, p50=0.000, p95=0.000
- MCP Latency (ms, all tools): count=5480, mean=0.698, p50=0.374, p95=0.884

## MCP Latency by Tool (ms)
- context.ensure_context: count=2, mean=3.980, p50=3.980, p95=4.149
- context.set_context: count=2, mean=1.155, p50=1.155, p95=1.256
- context.get_context: count=2638, mean=0.361, p50=0.312, p95=0.655
- memory.write_if_salient: count=2638, mean=0.466, p50=0.409, p95=0.793
- memory.retrieve: count=100, mean=15.366, p50=14.994, p95=24.606
- memory.retrieve_and_pack: count=100, mean=0.955, p50=0.870, p95=1.503

Note: LLM usage tokens are taken from API usage when available; otherwise estimated from text length.
