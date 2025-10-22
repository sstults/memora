import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignRequestInput {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | Uint8Array;
  region: string;
  service: string;
  credentials: AwsCredentials;
}

export function signAwsRequest(input: SignRequestInput) {
  const url = new URL(input.url);
  const now = new Date();
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const bodyHash = sha256Hex(input.body);

  const headers: Record<string, string> = { ...input.headers };
  headers.Host = url.host;
  headers["X-Amz-Date"] = amzDate;
  headers["X-Amz-Content-Sha256"] = bodyHash;

  if (input.credentials.sessionToken) {
    headers["X-Amz-Security-Token"] = input.credentials.sessionToken;
  }

  const headerEntries = Object.entries(headers)
    .map(([key, value]) => [key.toLowerCase(), value] as [string, string])
    .sort((a, b) => a[0].localeCompare(b[0]));

  const canonicalHeaders = headerEntries.map(([key, value]) => `${key}:${normalizeSpace(value)}`).join("\n") + "\n";

  const signedHeaders = headerEntries.map(([key]) => key).join(";");

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri(url.pathname),
    canonicalQuery(url.searchParams),
    canonicalHeaders,
    signedHeaders,
    bodyHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");

  const signingKey = getSignatureKey(input.credentials.secretAccessKey, dateStamp, input.region, input.service);
  const signature = hmac(signingKey, stringToSign).toString("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const signedHeadersOut: Record<string, string> = { ...headers, Authorization: authorization };
  return { headers: signedHeadersOut };
}

export function resolveAwsCredentials(profile: string): AwsCredentials {
  const envCreds = credentialsFromEnv();
  if (envCreds) return envCreds;

  const shared = credentialsFromSharedConfig(profile);
  if (shared) return shared;

  throw new Error(
    "Unable to resolve AWS credentials. Provide AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or configure a shared profile.",
  );
}

export function resolveAwsRegion(profile: string): string {
  const configPath = path.join(os.homedir(), ".aws", "config");
  const cfg = parseIniFile(configPath, true);
  const entry = cfg[profile];
  return entry?.region || "";
}

function credentialsFromEnv(): AwsCredentials | null {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (accessKeyId && secretAccessKey) {
    return {
      accessKeyId,
      secretAccessKey,
      sessionToken: process.env.AWS_SESSION_TOKEN,
    };
  }
  return null;
}

function credentialsFromSharedConfig(profile: string): AwsCredentials | null {
  const credPath = path.join(os.homedir(), ".aws", "credentials");
  const cfg = parseIniFile(credPath, false);
  const entry = cfg[profile];
  if (!entry) return null;
  const accessKeyId = entry.aws_access_key_id;
  const secretAccessKey = entry.aws_secret_access_key;
  if (!accessKeyId || !secretAccessKey) return null;
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: entry.aws_session_token || entry.session_token,
  };
}

type ParsedIni = Record<string, Record<string, string>>;

function parseIniFile(filePath: string, isConfigFile: boolean): ParsedIni {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return parseIni(raw, isConfigFile);
  } catch {
    return {};
  }
}

function parseIni(raw: string, isConfigFile: boolean): ParsedIni {
  const out: ParsedIni = {};
  let current: string | null = null;
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      let name = trimmed.slice(1, -1).trim();
      if (isConfigFile && name.startsWith("profile ")) {
        name = name.slice("profile ".length).trim();
      }
      current = name;
      if (!out[current]) out[current] = {};
      continue;
    }
    const idx = trimmed.indexOf("=");
    if (idx !== -1 && current) {
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim();
      out[current][key] = value;
    }
  }
  return out;
}

function normalizeSpace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function canonicalUri(pathname: string) {
  if (!pathname || pathname === "/") return "/";
  return encodeURI(pathname);
}

function canonicalQuery(params: URLSearchParams) {
  if (!params || Array.from(params.keys()).length === 0) return "";
  const pairs: string[] = [];
  params.sort();
  params.forEach((value, key) => {
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  });
  return pairs.join("&");
}

function sha256Hex(value: string | Uint8Array) {
  const data = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmac(key: crypto.BinaryLike, value: string) {
  return crypto.createHmac("sha256", key).update(value, "utf8").digest();
}

function getSignatureKey(secretAccessKey: string, dateStamp: string, region: string, service: string) {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

function toAmzDate(date: Date) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const min = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}T${hh}${min}${ss}Z`;
}
