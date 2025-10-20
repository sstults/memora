# LongMemEval Aggregates

- LLM latency (ms): count=100, mean=394.803, p50=193.314, p95=1221.881
- Tokens In: count=100, sum=252378, mean=2523.780, p50=1114.000, p95=6101.450
- Tokens Out: count=100, sum=766, mean=7.660, p50=1.000, p95=31.050
- MCP Latency (ms, all tools): count=2740, mean=0.558, p50=0.342, p95=0.784

## MCP Latency by Tool (ms)
- context.ensure_context: count=1, mean=2.894, p50=2.894, p95=2.894
- context.set_context: count=1, mean=0.909, p50=0.909, p95=0.909
- context.get_context: count=1319, mean=0.327, p50=0.297, p95=0.542
- memory.write_if_salient: count=1319, mean=0.411, p50=0.383, p95=0.627
- memory.retrieve: count=50, mean=10.215, p50=6.239, p95=10.555
- memory.retrieve_and_pack: count=50, mean=0.816, p50=0.775, p95=1.152

Note: LLM usage tokens are taken from API usage when available; otherwise estimated from text length.
