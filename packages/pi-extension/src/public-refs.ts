export type PublicRefKind = "message" | "block" | "checkpoint" | "artifact";

const PUBLIC_REF_PATTERN = /^acp:(message|block|checkpoint|artifact):(.+)$/;

export function publicAcpRef(kind: PublicRefKind, rawRef: string): string {
  return `acp:${kind}:${rawRef}`;
}

export function parsePublicAcpRef(value: string): { kind?: PublicRefKind; rawRef: string } {
  const match = value.match(PUBLIC_REF_PATTERN);
  return match ? { kind: match[1] as PublicRefKind, rawRef: match[2]! } : { rawRef: value };
}
