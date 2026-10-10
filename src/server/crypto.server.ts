import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify, type KeyObject } from "node:crypto";

// Minimal, dependency-free compact JWS (RFC 7515) over Ed25519 (alg "EdDSA",
// RFC 8037) using node:crypto. Keys travel as OKP JWKs.

export function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function b64urlDecode(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

/** Deterministic JSON: object keys sorted recursively. Used for hashing. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function randomId(prefix: string, bytes = 9): string {
  return `${prefix}_${randomBytes(bytes).toString("base64url")}`;
}

export function privateKeyFromEnvJwk(encoded: string): KeyObject {
  const jwk = JSON.parse(b64urlDecode(encoded).toString("utf8")) as JsonWebKey;
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.d) throw new Error("expected an Ed25519 private JWK");
  return createPrivateKey({ key: jwk, format: "jwk" });
}

export function publicKeyFromJwk(jwk: JsonWebKey): KeyObject {
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.x || jwk.d) throw new Error("expected an Ed25519 public JWK");
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" });
}

export function publicJwkOf(key: KeyObject): JsonWebKey {
  const jwk = createPublicKey(key).export({ format: "jwk" });
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x };
}

export interface JwsHeader {
  alg: "EdDSA";
  typ: string;
  kid: string;
}

export function signJws(header: JwsHeader, payload: object, privateKey: KeyObject): string {
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = sign(null, Buffer.from(signingInput), privateKey);
  return `${signingInput}.${b64url(signature)}`;
}

export type DecodedJws<T> = { header: JwsHeader; payload: T; signingInput: string; signature: Buffer };

/** Parse without verifying. Callers must verify before trusting anything. */
export function decodeJws<T = Record<string, unknown>>(jws: string): DecodedJws<T> | null {
  if (typeof jws !== "string") return null;
  const parts = jws.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]*$/.test(p))) return null;
  try {
    const header = JSON.parse(b64urlDecode(parts[0]).toString("utf8")) as JwsHeader;
    const payload = JSON.parse(b64urlDecode(parts[1]).toString("utf8")) as T;
    if (!header || typeof header !== "object" || !payload || typeof payload !== "object") return null;
    return { header, payload, signingInput: `${parts[0]}.${parts[1]}`, signature: b64urlDecode(parts[2]) };
  } catch {
    return null;
  }
}

export function verifyJwsSignature(decoded: DecodedJws<unknown>, publicKey: KeyObject): boolean {
  if (decoded.header.alg !== "EdDSA" || decoded.signature.length !== 64) return false;
  try {
    return verify(null, Buffer.from(decoded.signingInput), publicKey, decoded.signature);
  } catch {
    return false;
  }
}
