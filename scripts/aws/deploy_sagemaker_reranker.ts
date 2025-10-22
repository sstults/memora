import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

import {
  AwsCredentials,
  resolveAwsCredentials,
  resolveAwsRegion,
  signAwsRequest,
} from "../../src/services/aws.js";

interface RawArgs {
  [key: string]: string | boolean | undefined;
}

interface DeployOptions {
  profile: string;
  region: string;
  endpointName: string;
  modelName: string;
  endpointConfigName: string;
  variantName: string;
  variantWeight: number;
  instanceType: string;
  initialInstanceCount: number;
  volumeSize: number;
  roleArn: string;
  containerImage: string;
  hfModelId: string;
  maxInputLength: number;
  hfTask?: string;
  hfApiToken?: string;
  extraEnvironment: Record<string, string>;
  waitForService: boolean;
  tags: Record<string, string>;
  subnetIds: string[];
  securityGroupIds: string[];
  artifactBucket: string;
  artifactKey: string;
  modelDataUrl: string;
  reuseModelData: boolean;
}

interface AwsJsonResponse<T> {
  data: T;
  requestId?: string;
}

class AwsServiceError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "AwsServiceError";
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  try {
    const raw = parseArgs();
    if (raw.help) {
      printUsage();
      return;
    }

    const profile = stringOption(raw.profile) || process.env.RERANK_SAGEMAKER_PROFILE || process.env.AWS_PROFILE || "default";
    const region =
      stringOption(raw.region) ||
      process.env.RERANK_SAGEMAKER_REGION ||
      process.env.AWS_REGION ||
      process.env.AWS_DEFAULT_REGION ||
      resolveAwsRegion(profile);

    if (!region) {
      throw new Error("Unable to determine AWS region. Pass --region or set RERANK_SAGEMAKER_REGION.");
    }

    const endpointName =
      stringOption(raw["endpoint-name"]) || process.env.RERANK_SAGEMAKER_ENDPOINT_NAME || "memora-bge-reranker";

    const roleArn = stringOption(raw["role-arn"]) || process.env.SAGEMAKER_EXECUTION_ROLE_ARN;
    if (!roleArn) {
      throw new Error("Missing --role-arn (or SAGEMAKER_EXECUTION_ROLE_ARN). This is required for SageMaker to access AWS.");
    }

    const instanceType =
      stringOption(raw["instance-type"]) || process.env.RERANK_SAGEMAKER_INSTANCE_TYPE || "ml.g5.2xlarge";
    const initialCount = numberOption(raw["initial-instance-count"], process.env.RERANK_SAGEMAKER_INITIAL_INSTANCE_COUNT, 1);
    const volumeSize = numberOption(raw["volume-size"], process.env.RERANK_SAGEMAKER_VOLUME_SIZE, 100);
    const maxInputLength = numberOption(raw["max-input-length"], process.env.RERANK_SAGEMAKER_MAX_INPUT_LENGTH, 1024);
    const variantWeight = numberOption(raw["variant-weight"], process.env.RERANK_SAGEMAKER_VARIANT_WEIGHT, 1);

    const modelName = stringOption(raw["model-name"]) || `${endpointName}-model`;
    const endpointConfigName = stringOption(raw["endpoint-config-name"]) || `${endpointName}-config`;
    const variantName = stringOption(raw["variant-name"]) || "AllTraffic";

    const hfModelId = stringOption(raw["model-id"]) || process.env.RERANK_SAGEMAKER_MODEL_ID || "BAAI/bge-reranker-large";
    const hfTask = stringOption(raw["hf-task"]) || process.env.RERANK_SAGEMAKER_TASK || "custom";
    const hfApiToken = stringOption(raw["hf-api-token"]) || process.env.HUGGINGFACEHUB_API_TOKEN || process.env.HF_API_TOKEN;

    const waitForService = booleanOption(raw.wait, true);

    const tags = parseKeyValueMap(stringOption(raw.tags) || process.env.RERANK_SAGEMAKER_TAGS);
    const extraEnv = parseKeyValueMap(stringOption(raw["extra-env"]) || process.env.RERANK_SAGEMAKER_EXTRA_ENV);

    const subnetIds = parseList(stringOption(raw["subnet-ids"]) || process.env.RERANK_SAGEMAKER_SUBNET_IDS);
    const securityGroupIds = parseList(stringOption(raw["security-group-ids"]) || process.env.RERANK_SAGEMAKER_SECURITY_GROUP_IDS);

    const explicitModelDataUrl = stringOption(raw["model-data-url"]) || process.env.RERANK_SAGEMAKER_MODEL_DATA_URL;
    const artifactBucket =
      stringOption(raw["artifact-bucket"]) || process.env.RERANK_SAGEMAKER_ARTIFACT_BUCKET || "";
    const artifactKey =
      stringOption(raw["artifact-key"]) || process.env.RERANK_SAGEMAKER_ARTIFACT_KEY || `memora/bge-reranker/model.tar.gz`;

    const containerImage =
      stringOption(raw["container-image"]) ||
      process.env.RERANK_SAGEMAKER_CONTAINER_IMAGE ||
      huggingFaceImageForRegion(region);

    const credentials = resolveAwsCredentials(profile);

    let modelDataUrl = explicitModelDataUrl || "";
    let reuseModelData = Boolean(explicitModelDataUrl);
    let resolvedBucket = artifactBucket;

  if (!reuseModelData) {
    const bucketToUse = resolvedBucket || (await ensureArtifactBucket(region, credentials));
    if (resolvedBucket) {
      await createBucket(resolvedBucket, region, credentials);
    }
    resolvedBucket = bucketToUse;
    const uploadKey = artifactKey.startsWith("/") ? artifactKey.slice(1) : artifactKey;
    const { archivePath, cleanup } = await buildModelArchive();
      try {
        await uploadModelArtifact(bucketToUse, uploadKey, archivePath, region, credentials);
      } finally {
        cleanup();
      }
      modelDataUrl = `s3://${bucketToUse}/${uploadKey}`;
    }

    if (!modelDataUrl) {
      throw new Error("Unable to determine model data S3 location.");
    }

    const options: DeployOptions = {
      profile,
      region,
      endpointName,
      modelName,
      endpointConfigName,
      variantName,
      variantWeight,
      instanceType,
      initialInstanceCount: initialCount,
      volumeSize,
      roleArn,
      containerImage,
      hfModelId,
      maxInputLength,
      hfTask,
      hfApiToken,
      extraEnvironment: extraEnv,
      waitForService,
      tags,
      subnetIds,
      securityGroupIds,
      artifactBucket: resolvedBucket,
      artifactKey,
      modelDataUrl,
      reuseModelData,
    };

    console.log(`Using AWS profile="${profile}" region="${region}"`);
    await deployReranker(options, credentials);
  } catch (err) {
    console.error("\nDeployment failed:", (err as Error).message);
    if ((err as AwsServiceError).requestId) {
      const svcErr = err as AwsServiceError;
      console.error(`Service error ${svcErr.code} (status ${svcErr.statusCode}) requestId=${svcErr.requestId}`);
    }
    process.exitCode = 1;
  }
}

async function deployReranker(options: DeployOptions, credentials: AwsCredentials) {
  const { region } = options;

  console.log(`Model data: ${options.modelDataUrl}`);
  if (options.reuseModelData) {
    console.log("Reusing existing model artifact (no upload performed).");
  } else {
    console.log(`Uploaded artifact to s3://${options.artifactBucket}/${options.artifactKey}`);
  }

  const existingModel = await describeModel(options.modelName, region, credentials);
  if (existingModel) {
    console.log(`Model ${options.modelName} already exists. Skipping creation.`);
  } else {
    console.log(`Creating model ${options.modelName}...`);
    await createModel(options, region, credentials);
    console.log("Model created.");
  }

  const existingConfig = await describeEndpointConfig(options.endpointConfigName, region, credentials);
  if (existingConfig) {
    console.log(`EndpointConfig ${options.endpointConfigName} already exists.`);
  } else {
    console.log(`Creating endpoint config ${options.endpointConfigName}...`);
    await createEndpointConfig(options, region, credentials);
    console.log("Endpoint config created.");
  }

  const endpoint = await describeEndpoint(options.endpointName, region, credentials);
  if (!endpoint) {
    console.log(`Creating endpoint ${options.endpointName}...`);
    await createEndpoint(options.endpointName, options.endpointConfigName, options.tags, region, credentials);
  } else if (endpoint.EndpointConfigName !== options.endpointConfigName) {
    console.log(`Updating endpoint ${options.endpointName} to config ${options.endpointConfigName}...`);
    await updateEndpoint(options.endpointName, options.endpointConfigName, region, credentials);
  } else {
    console.log(`Endpoint ${options.endpointName} already uses config ${options.endpointConfigName}.`);
  }

  if (options.waitForService) {
    console.log("Waiting for endpoint to become InService (this can take ~15 minutes)...");
    await waitForEndpoint(options.endpointName, region, credentials);
    console.log("Endpoint is InService.");
  } else {
    console.log("Skipping wait (--no-wait).");
  }
}

async function buildModelArchive(): Promise<{ archivePath: string; cleanup: () => void }> {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "memora-sm-"));
  const codeDir = path.join(tmpBase, "code");
  fs.mkdirSync(codeDir);

  const templateDir = path.join(__dirname, "templates/bge_reranker");
  const files = fs.readdirSync(templateDir);
  for (const file of files) {
    const src = path.join(templateDir, file);
    const dest = path.join(codeDir, file);
    fs.copyFileSync(src, dest);
  }

  const archivePath = path.join(tmpBase, "model.tar.gz");
  await runTar(archivePath, tmpBase);

  return {
    archivePath,
    cleanup: () => {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    },
  };
}

async function runTar(archivePath: string, sourceDir: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-czf", archivePath, "-C", sourceDir, "code"], {
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tar exited with status ${code}`));
      }
    });
    child.on("error", (err) => reject(err));
  });
}

async function ensureArtifactBucket(region: string, credentials: AwsCredentials): Promise<string> {
  const proposed = `memora-sagemaker-${region}-${crypto.randomBytes(4).toString("hex")}`.toLowerCase();
  await createBucket(proposed, region, credentials);
  return proposed;
}

async function createBucket(bucket: string, region: string, credentials: AwsCredentials) {
  const host = region === "us-east-1" ? "s3.amazonaws.com" : `s3.${region}.amazonaws.com`;
  const url = `https://${host}/${bucket}`;
  const body =
    region === "us-east-1"
      ? ""
      : `<CreateBucketConfiguration xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><LocationConstraint>${region}</LocationConstraint></CreateBucketConfiguration>`;
  const headers: Record<string, string> = { "Content-Type": "application/xml" };
  if (!body) {
    headers["Content-Length"] = "0";
  } else {
    headers["Content-Length"] = String(Buffer.byteLength(body));
  }
  const signed = signAwsRequest({
    url,
    method: "PUT",
    headers,
    body: body || "",
    region,
    service: "s3",
    credentials,
  });
  const res = await fetch(url, {
    method: "PUT",
    headers: signed.headers,
    body: body ? body : undefined,
  });
  if (!res.ok && res.status !== 409) {
    const text = await res.text();
    throw new Error(`CreateBucket failed (${res.status}): ${text}`);
  }
}

async function uploadModelArtifact(
  bucket: string,
  key: string,
  archivePath: string,
  region: string,
  credentials: AwsCredentials,
) {
  const host = `${bucket}.s3.${region}.amazonaws.com`;
  const url = `https://${host}/${encodeS3Key(key)}`;
  const body = fs.readFileSync(archivePath);
  const headers: Record<string, string> = {
    "Content-Type": "application/x-tar",
    "Content-Length": String(body.length),
  };
  const signed = signAwsRequest({
    url,
    method: "PUT",
    headers,
    body,
    region,
    service: "s3",
    credentials,
  });
  const res = await fetch(url, {
    method: "PUT",
    headers: signed.headers,
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to upload model artifact (${res.status}): ${text}`);
  }
}

function encodeS3Key(key: string) {
  return key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

async function createModel(options: DeployOptions, region: string, credentials: AwsCredentials) {
  const target = "SageMaker.CreateModel";
  const env: Record<string, string> = {
    HF_MODEL_ID: options.hfModelId,
    MAX_INPUT_LENGTH: String(options.maxInputLength),
    SAGEMAKER_PROGRAM: "inference.py",
    SAGEMAKER_SUBMIT_DIRECTORY: options.modelDataUrl,
  };
  if (options.hfTask && options.hfTask !== "custom") {
    env.HF_TASK = options.hfTask;
  }
  if (options.hfApiToken) {
    env.HF_API_TOKEN = options.hfApiToken;
    env.HUGGING_FACE_HUB_TOKEN = options.hfApiToken;
  }
  for (const [key, value] of Object.entries(options.extraEnvironment)) {
    env[key] = value;
  }
  const body = {
    ModelName: options.modelName,
    ExecutionRoleArn: options.roleArn,
    PrimaryContainer: {
      Image: options.containerImage,
      ModelDataUrl: options.modelDataUrl,
      Environment: env,
    },
  } as Record<string, any>;
  if (options.subnetIds.length > 0 && options.securityGroupIds.length > 0) {
    body.VpcConfig = {
      Subnets: options.subnetIds,
      SecurityGroupIds: options.securityGroupIds,
    };
  }
  await callSageMakerJson(target, body, region, credentials);
}

async function createEndpointConfig(options: DeployOptions, region: string, credentials: AwsCredentials) {
  const target = "SageMaker.CreateEndpointConfig";
  const variant: Record<string, any> = {
    VariantName: options.variantName,
    ModelName: options.modelName,
    InitialInstanceCount: options.initialInstanceCount,
    InstanceType: options.instanceType,
    InitialVariantWeight: options.variantWeight,
  };
  if (options.volumeSize > 0) {
    variant.VolumeSizeInGB = options.volumeSize;
  }
  const body = {
    EndpointConfigName: options.endpointConfigName,
    ProductionVariants: [variant],
  };
  await callSageMakerJson(target, body, region, credentials);
}

async function createEndpoint(
  endpointName: string,
  endpointConfigName: string,
  tags: Record<string, string>,
  region: string,
  credentials: AwsCredentials,
) {
  const body: Record<string, any> = {
    EndpointName: endpointName,
    EndpointConfigName: endpointConfigName,
  };
  const tagList = Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));
  if (tagList.length > 0) {
    body.Tags = tagList;
  }
  await callSageMakerJson("SageMaker.CreateEndpoint", body, region, credentials);
}

async function updateEndpoint(
  endpointName: string,
  endpointConfigName: string,
  region: string,
  credentials: AwsCredentials,
) {
  const body = {
    EndpointName: endpointName,
    EndpointConfigName: endpointConfigName,
  };
  await callSageMakerJson("SageMaker.UpdateEndpoint", body, region, credentials);
}

async function waitForEndpoint(endpointName: string, region: string, credentials: AwsCredentials) {
  const start = Date.now();
  while (true) {
    const desc = await describeEndpoint(endpointName, region, credentials);
    if (!desc) {
      throw new Error(`Endpoint ${endpointName} disappeared while waiting for InService.`);
    }
    const status = desc.EndpointStatus;
    if (status === "InService") {
      return;
    }
    if (status === "Failed") {
      throw new Error(`Endpoint ${endpointName} failed: ${desc.FailureReason || "unknown"}`);
    }
    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`  status=${status} elapsed=${elapsed}s`);
    await new Promise((r) => setTimeout(r, 15000));
  }
}

async function describeModel(modelName: string, region: string, credentials: AwsCredentials) {
  try {
    const res = await callSageMakerJson<{ ModelName: string }>(
      "SageMaker.DescribeModel",
      { ModelName: modelName },
      region,
      credentials,
    );
    return res.data;
  } catch (err) {
    if (isNotFound(err)) {
      return null;
    }
    throw err;
  }
}

async function describeEndpointConfig(name: string, region: string, credentials: AwsCredentials) {
  try {
    const res = await callSageMakerJson<{ EndpointConfigName: string }>(
      "SageMaker.DescribeEndpointConfig",
      { EndpointConfigName: name },
      region,
      credentials,
    );
    return res.data;
  } catch (err) {
    if (isNotFound(err)) {
      return null;
    }
    throw err;
  }
}

async function describeEndpoint(name: string, region: string, credentials: AwsCredentials) {
  try {
    const res = await callSageMakerJson<Record<string, any>>(
      "SageMaker.DescribeEndpoint",
      { EndpointName: name },
      region,
      credentials,
    );
    return res.data;
  } catch (err) {
    if (isNotFound(err)) {
      return null;
    }
    throw err;
  }
}

function isNotFound(err: unknown): boolean {
  if (!(err instanceof AwsServiceError)) return false;
  const code = err.code || "";
  if (code.toLowerCase().includes("notfound")) return true;
  if (err.code === "ValidationException" && /could not find/i.test(err.message)) return true;
  if (err.code === "ValidationException" && /does not exist/i.test(err.message)) return true;
  if (err.code === "ResourceNotFound" || err.code === "ResourceNotFoundException") return true;
  return false;
}

async function callSageMakerJson<T = Record<string, any>>(
  target: string,
  body: Record<string, any>,
  region: string,
  credentials: AwsCredentials,
): Promise<AwsJsonResponse<T>> {
  const host = `api.sagemaker.${region}.amazonaws.com`;
  const url = `https://${host}/`;
  const payload = JSON.stringify(body);
  const headers: Record<string, string> = {
    "Content-Type": "application/x-amz-json-1.1",
    "X-Amz-Target": target,
  };
  const signed = signAwsRequest({
    url,
    method: "POST",
    headers,
    body: payload,
    region,
    service: "sagemaker",
    credentials,
  });
  const res = await fetch(url, {
    method: "POST",
    headers: signed.headers,
    body: payload,
  });
  const text = await res.text();
  const requestId = res.headers.get("x-amzn-requestid") || res.headers.get("x-amz-request-id") || undefined;
  if (!res.ok) {
    let code = "UnknownError";
    let message = text || "SageMaker request failed";
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed.__type === "string") {
        code = parsed.__type.split("#").pop() || code;
      }
      if (typeof parsed.message === "string") {
        message = parsed.message;
      } else if (typeof parsed.Message === "string") {
        message = parsed.Message;
      }
    } catch {
      // ignore parse error
    }
    throw new AwsServiceError(message, code, res.status, requestId);
  }
  const data = text ? (JSON.parse(text) as T) : ({} as T);
  return { data, requestId };
}

function parseArgs(): RawArgs {
  const args = process.argv.slice(2);
  const out: RawArgs = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      continue;
    }
    if (arg.startsWith("--no-")) {
      const key = arg.slice(5);
      out[key] = false;
      continue;
    }
    const eqIdx = arg.indexOf("=");
    if (eqIdx !== -1) {
      const key = arg.slice(2, eqIdx);
      out[key] = arg.slice(eqIdx + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function stringOption(value: string | boolean | undefined): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return undefined;
}

function numberOption(value: string | boolean | undefined, fallbackEnv: string | undefined, defaultValue: number): number {
  if (typeof value === "string" && value.trim().length > 0) {
    const num = Number(value);
    if (!Number.isNaN(num)) return num;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (fallbackEnv) {
    const num = Number(fallbackEnv);
    if (!Number.isNaN(num)) return num;
  }
  return defaultValue;
}

function booleanOption(value: string | boolean | undefined, defaultValue: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lowered = value.toLowerCase();
    if (lowered === "true" || lowered === "1") return true;
    if (lowered === "false" || lowered === "0") return false;
  }
  return defaultValue;
}

function parseKeyValueMap(value?: string): Record<string, string> {
  if (!value) return {};
  const out: Record<string, string> = {};
  const parts = value.split(/[,;]+/);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) {
      continue;
    }
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (key) {
      out[key] = val;
    }
  }
  return out;
}

function parseList(value?: string): string[] {
  if (!value) return [];
  return value
    .split(/[,;\s]+/)
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function huggingFaceImageForRegion(region: string): string {
  const account = HUGGING_FACE_ACCOUNT_IDS[region];
  if (!account) {
    throw new Error(
      `No default HuggingFace container account for region ${region}. Pass --container-image explicitly.`,
    );
  }
  // PyTorch 2.6.0 with transformers 4.51.3 - compatible with sentence-transformers CrossEncoder
  // This image is verified to exist in us-east-1 and other major regions
  return `${account}.dkr.ecr.${region}.amazonaws.com/huggingface-pytorch-inference:2.6.0-transformers4.51.3-gpu-py312-cu124-ubuntu22.04`;
}

const HUGGING_FACE_ACCOUNT_IDS: Record<string, string> = {
  "us-east-1": "763104351884",
  "us-east-2": "763104351884",
  "us-west-1": "763104351884",
  "us-west-2": "763104351884",
  "ca-central-1": "763104351884",
  "eu-central-1": "763104351884",
  "eu-west-1": "763104351884",
  "eu-west-2": "763104351884",
  "eu-west-3": "763104351884",
  "eu-north-1": "763104351884",
  "eu-south-1": "763104351884",
  "eu-south-2": "763104351884",
  "ap-southeast-1": "763104351884",
  "ap-southeast-2": "763104351884",
  "ap-southeast-3": "871362719292",
  "ap-southeast-4": "217643126080",
  "ap-northeast-1": "763104351884",
  "ap-northeast-2": "763104351884",
  "ap-northeast-3": "763104351884",
  "ap-south-1": "763104351884",
  "ap-south-2": "900889452093",
  "ap-east-1": "871362719292",
  "sa-east-1": "763104351884",
  "me-south-1": "217643126080",
  "me-central-1": "217643126080",
  "af-south-1": "763104351884",
};

function printUsage() {
  console.log(`Deploy the BGE reranker to SageMaker.

Usage: node --import ./scripts/register-ts-node.mjs scripts/aws/deploy_sagemaker_reranker.ts [options]

Options:
  --region <name>                 AWS region (defaults to RERANK_SAGEMAKER_REGION/AWS_REGION)
  --profile <name>                AWS profile name for shared credentials
  --role-arn <arn>                REQUIRED SageMaker execution role ARN
  --endpoint-name <name>          SageMaker endpoint name (default: memora-bge-reranker)
  --model-name <name>             SageMaker model name (default: <endpoint-name>-model)
  --endpoint-config-name <name>   Endpoint config name (default: <endpoint-name>-config)
  --instance-type <type>          Instance type (default: ml.g5.2xlarge)
  --initial-instance-count <n>    Number of instances (default: 1)
  --volume-size <gb>              EBS volume size (default: 100)
  --variant-name <name>           Production variant name (default: AllTraffic)
  --variant-weight <weight>       Variant weight (default: 1)
  --model-id <hf id>              HuggingFace model id (default: BAAI/bge-reranker-large)
  --max-input-length <tokens>     Max token length for CrossEncoder (default: 1024)
  --hf-task <task>                Optional HF_TASK override (default: custom)
  --hf-api-token <token>          HuggingFace Hub token for gated models
  --container-image <uri>         Override inference container image URI
  --artifact-bucket <name>        Existing S3 bucket for model artifact
  --artifact-key <key>            Object key for model artifact (default: memora/bge-reranker/model.tar.gz)
  --model-data-url <s3://...>     Reuse an existing model artifact and skip upload
  --subnet-ids <id1,id2>          Optional VPC subnets for the model (requires security groups)
  --security-group-ids <ids>      Optional VPC security groups (requires subnet ids)
  --tags key=value[,k=v]          Tags to apply to the endpoint
  --extra-env key=value[,k=v]     Additional environment variables for the container
  --no-wait                       Do not wait for the endpoint to reach InService
  --help                          Show this help
`);
}

await main();
