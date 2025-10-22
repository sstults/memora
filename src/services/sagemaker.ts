import { debug } from "./log.js";
import { resolveAwsCredentials, resolveAwsRegion, signAwsRequest } from "./aws.js";

export interface InvokeSageMakerOptions {
  endpointName: string;
  query: string;
  passages: string[];
  timeoutMs: number;
  accept?: string;
  contentType?: string;
  region?: string;
  profile?: string;
}

const DEFAULT_ACCEPT = process.env.RERANK_SAGEMAKER_ACCEPT || "application/json";
const DEFAULT_CONTENT_TYPE = process.env.RERANK_SAGEMAKER_CONTENT_TYPE || "application/json";
const DEFAULT_PROFILE = process.env.RERANK_SAGEMAKER_PROFILE || process.env.AWS_PROFILE || "default";
const DEFAULT_REGION =
  process.env.RERANK_SAGEMAKER_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "";

const log = debug("memora:sagemaker");

export async function invokeSageMakerRerank(options: InvokeSageMakerOptions): Promise<number[]> {
  const accept = options.accept || DEFAULT_ACCEPT;
  const contentType = options.contentType || DEFAULT_CONTENT_TYPE;
  const profile = options.profile || DEFAULT_PROFILE;
  const region = options.region || DEFAULT_REGION || resolveAwsRegion(profile);

  if (!region) {
    throw new Error("Unable to determine AWS region for SageMaker invocation. Set RERANK_SAGEMAKER_REGION or AWS_REGION.");
  }

  const creds = resolveAwsCredentials(profile);
  const host = `runtime.sagemaker.${region}.amazonaws.com`;
  const pathName = `/endpoints/${encodeURIComponent(options.endpointName)}/invocations`;
  const url = `https://${host}${pathName}`;
  const payload = JSON.stringify({
    inputs: {
      source_sentence: options.query,
      sentences: options.passages,
    },
  });

  const headers: Record<string, string> = {
    Accept: accept,
    "Content-Type": contentType,
    Host: host,
  };

  if (creds.sessionToken) {
    headers["X-Amz-Security-Token"] = creds.sessionToken;
  }

  const signed = signAwsRequest({
    url,
    method: "POST",
    headers,
    body: payload,
    region,
    service: "sagemaker",
    credentials: creds,
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(250, options.timeoutMs));

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: signed.headers,
      body: payload,
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const txt = await safeText(res);
      throw new Error(`SageMaker invoke failed (HTTP ${res.status}): ${txt.slice(0, 200)}`);
    }

    const txt = await res.text();
    const scores = parseScores(txt);
    if (!scores) {
      throw new Error(`Unable to parse SageMaker rerank response: ${txt.slice(0, 200)}`);
    }
    log("invoke.ok", { count: scores.length, region, endpoint: options.endpointName });
    return scores;
  } finally {
    clearTimeout(timer);
  }
}

function parseScores(bodyText: string): number[] | null {
  if (!bodyText) return [];

  // Try simple JSON parse first
  try {
    const parsed = JSON.parse(bodyText);

    // Handle case where output_fn returns [body, content-type] tuple that gets JSON-serialized
    if (Array.isArray(parsed) && parsed.length >= 1 && typeof parsed[0] === "string") {
      try {
        const inner = JSON.parse(parsed[0]);
        const scores = extractScores(inner);
        if (scores) return scores;
      } catch {
        // Fall through
      }
    }

    const scores = extractScores(parsed);
    if (scores) return scores;
  } catch {
    // Fall through to handle JSON lines or plain numbers
  }

  const lines = bodyText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length > 1) {
    const values: number[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        const scores = extractScores(parsed);
        if (scores) {
          values.push(...scores);
        } else if (typeof parsed === "number") {
          values.push(parsed);
        }
      } catch {
        const num = Number(line);
        if (!Number.isNaN(num)) {
          values.push(num);
        } else {
          return null;
        }
      }
    }
    return values;
  }

  const single = Number(bodyText.trim());
  return Number.isNaN(single) ? null : [single];
}

function extractScores(data: any): number[] | null {
  if (Array.isArray(data)) {
    return flattenToNumbers(data);
  }
  if (!data || typeof data !== "object") return null;
  if (Array.isArray(data.scores)) {
    return flattenToNumbers(data.scores);
  }
  if (Array.isArray(data.outputs)) {
    return flattenToNumbers(data.outputs);
  }
  if (Array.isArray(data.logits)) {
    return flattenToNumbers(data.logits);
  }
  if (Array.isArray(data.result)) {
    return flattenToNumbers(data.result);
  }
  return null;
}

function flattenToNumbers(value: any[]): number[] | null {
  const out: number[] = [];
  const stack = [...value];
  while (stack.length) {
    const cur = stack.shift();
    if (Array.isArray(cur)) {
      stack.unshift(...cur);
    } else if (cur != null && typeof cur === "object") {
      // For objects like { score: 0.1 }
      if (typeof cur.score === "number") {
        out.push(cur.score);
      } else {
        return null;
      }
    } else {
      const num = Number(cur);
      if (Number.isNaN(num)) {
        return null;
      }
      out.push(num);
    }
  }
  return out;
}


async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch (err) {
    log("invoke.read_error", { message: (err as Error).message });
    return "";
  }
}

