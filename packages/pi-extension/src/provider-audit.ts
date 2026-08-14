import { createHash } from "node:crypto";
import { defaultCountTokens } from "acp-kernel";

export interface SanitizedProviderPayload {
  payload: unknown;
  droppedMedia: number;
}

export interface ProviderPayloadAudit {
  payloadHash: string;
  canonicalPayloadHash: string;
  toolSchemaFingerprint: string;
  systemPromptFingerprint: string;
  fixedPrefixFingerprint: string;
  textTokens: number;
  mediaTokens: number;
  unverifiedMediaTokens: number;
  estimatedTokens: number;
  mediaVerified: boolean;
  unsafeMediaAction?: "externalize-or-drop-unverified-media";
}

interface MediaEstimate {
  verified: number;
  unverified: number;
}

/** Audit the exact provider payload after every extension has transformed it. */
export function sanitizeUnsafeProviderMedia(payload: unknown): SanitizedProviderPayload {
  let droppedMedia = 0;
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    if (isMediaObject(object) && !(numeric(object.width) && numeric(object.height))) {
      droppedMedia++;
      return {
        type: "text",
        text: "[ACP omitted unverified media from this provider request. Externalize it or resend it with verified dimensions.]",
      };
    }
    return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, visit(item)]));
  };
  return { payload: visit(payload), droppedMedia };
}

export function deepFreezeProviderPayload<T>(payload: T): T {
  if (!payload || typeof payload !== "object" || Object.isFrozen(payload)) return payload;
  Object.freeze(payload);
  for (const value of Object.values(payload as Record<string, unknown>)) deepFreezeProviderPayload(value);
  return payload;
}

export function auditProviderPayload(payload: unknown, provider?: string): ProviderPayloadAudit {
  const systems: unknown[] = [];
  const tools: unknown[] = [];
  const media: MediaEstimate = { verified: 0, unverified: 0 };
  const scrubbed = scrubPayload(payload, provider ?? "unknown", systems, tools, media, "");
  const canonical = stableStringify(scrubbed);
  const systemCanonical = stableStringify(systems);
  const toolsCanonical = stableStringify(tools);
  const textTokens = defaultCountTokens(canonical);
  // Unknown raw media receives a bounded provisional charge. It can trigger a
  // deterministic externalize/drop action, but cannot permanently deny tools.
  const provisionalUnverified = Math.min(media.unverified, 4_096);
  const mediaTokens = media.verified + provisionalUnverified;
  const systemPromptFingerprint = sha256(systemCanonical);
  const toolSchemaFingerprint = sha256(toolsCanonical);
  return {
    payloadHash: sha256(stableStringify(payload)),
    canonicalPayloadHash: sha256(canonical),
    toolSchemaFingerprint,
    systemPromptFingerprint,
    fixedPrefixFingerprint: sha256(`${systemPromptFingerprint}:${toolSchemaFingerprint}`),
    textTokens,
    mediaTokens,
    unverifiedMediaTokens: media.unverified,
    estimatedTokens: textTokens + mediaTokens,
    mediaVerified: media.unverified === 0,
    ...(media.unverified > 0 ? { unsafeMediaAction: "externalize-or-drop-unverified-media" as const } : {}),
  };
}

function scrubPayload(
  value: unknown,
  provider: string,
  systems: unknown[],
  tools: unknown[],
  media: MediaEstimate,
  key: string,
): unknown {
  if (typeof value === "string") {
    if (looksLikeMediaKey(key) || value.startsWith("data:image/")) {
      const bytes = encodedMediaBytes(value);
      const estimate = estimateMedia(provider, undefined, undefined, undefined, bytes);
      media.verified += estimate.verified;
      media.unverified += estimate.unverified;
      return `[media sha256=${sha256(value)} bytes=${bytes}]`;
    }
    return value;
  }
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => scrubPayload(item, provider, systems, tools, media, key));
  const input = value as Record<string, unknown>;
  const mediaObject = isMediaObject(input);
  if (mediaObject) {
    const width = numeric(input.width);
    const height = numeric(input.height);
    const detail = typeof input.detail === "string" ? input.detail : undefined;
    const source = mediaSource(input);
    const bytes = typeof source === "string" ? encodedMediaBytes(source) : undefined;
    const estimate = estimateMedia(provider, width, height, detail, bytes);
    media.verified += estimate.verified;
    media.unverified += estimate.unverified;
  }
  const output: Record<string, unknown> = {};
  for (const [childKey, child] of Object.entries(input).sort(([left], [right]) => left.localeCompare(right))) {
    const lower = childKey.toLowerCase();
    if (lower === "tools" || lower === "functions") tools.push(child);
    if (lower === "system" || lower === "systemprompt" || lower === "instructions") systems.push(child);
    if (lower === "messages" && Array.isArray(child)) {
      for (const message of child) {
        if (message && typeof message === "object" && (message as { role?: unknown }).role === "system") systems.push(message);
      }
    }
    if (mediaObject && (lower === "data" || lower === "source" || lower === "image_url" || lower === "url")) {
      const serialized = typeof child === "string" ? child : stableStringify(child);
      output[childKey] = `[media sha256=${sha256(serialized)} bytes=${encodedMediaBytes(serialized)}]`;
    } else {
      output[childKey] = scrubPayload(child, provider, systems, tools, media, childKey);
    }
  }
  return output;
}

function estimateMedia(provider: string, width?: number, height?: number, detail?: string, bytes?: number): MediaEstimate {
  if (width && height) {
    if (provider.includes("openai")) {
      if (detail === "low") return { verified: 85, unverified: 0 };
      const tiles = Math.max(1, Math.ceil(width / 512) * Math.ceil(height / 512));
      return { verified: 85 + 170 * tiles, unverified: 0 };
    }
    // Anthropic and Gemini publish pixel-area based guidance. Use the more
    // conservative common estimate for an already-decoded image.
    return { verified: Math.max(1, Math.ceil((width * height) / 750)), unverified: 0 };
  }
  if (bytes !== undefined) return { verified: 0, unverified: Math.max(1, Math.ceil(bytes / 3)) };
  return { verified: 0, unverified: 1_024 };
}

function isMediaObject(value: Record<string, unknown>): boolean {
  const type = typeof value.type === "string" ? value.type.toLowerCase() : "";
  return type.includes("image") || "image_url" in value || ("source" in value && mediaSource(value) !== undefined);
}

function mediaSource(value: Record<string, unknown>): unknown {
  const imageUrl = value.image_url;
  if (typeof imageUrl === "string") return imageUrl;
  if (imageUrl && typeof imageUrl === "object") return (imageUrl as { url?: unknown }).url;
  const source = value.source;
  if (typeof source === "string") return source;
  if (source && typeof source === "object") return (source as { data?: unknown }).data;
  return value.data;
}

function looksLikeMediaKey(key: string): boolean {
  const lower = key.toLowerCase();
  return lower === "data" || lower === "image" || lower === "image_url" || lower === "url";
}

function encodedMediaBytes(value: string): number {
  const comma = value.indexOf(",");
  const body = value.startsWith("data:") && comma >= 0 ? value.slice(comma + 1) : value;
  if (/^[A-Za-z0-9+/\s]+=*$/.test(body) && body.length >= 32) return Math.floor(body.replace(/\s/g, "").length * 3 / 4);
  return Buffer.byteLength(value, "utf8");
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, sortValue(child)]));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
