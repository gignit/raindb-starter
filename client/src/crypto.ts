// crypto.ts -- OFF-THE-GRID (zero-knowledge) journal encryption, 100% in the
// browser. The server NEVER sees your passphrase or your plaintext: an encrypted
// entry is AES-GCM ciphertext produced HERE, and only { encrypted, ciphertext,
// tags } ever leaves the device. If you lose the passphrase, the entry is gone
// forever -- there is no recovery, by design. That is the point: not even the
// platform can read it.
//
// Mechanics (all Web Crypto, no dependencies):
//   passphrase --PBKDF2(210k, SHA-256)--> AES-256-GCM key
//   plaintext  --AES-GCM(random 96-bit IV)--> ciphertext
//   stored blob = base64( salt(16) || iv(12) || ciphertext )
// The salt + IV are random per encryption and travel WITH the ciphertext (they
// are not secret; the passphrase is). Tags are deliberately left PLAINTEXT so the
// AI can still find an entry by tag without ever reading its body.

const PBKDF2_ITERS = 210_000;

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERS, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt plaintext with a passphrase. Returns a self-contained base64 blob. */
export async function encrypt(plaintext: string, passphrase: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, new TextEncoder().encode(plaintext)),
  );
  const blob = new Uint8Array(salt.length + iv.length + ct.length);
  blob.set(salt, 0);
  blob.set(iv, salt.length);
  blob.set(ct, salt.length + iv.length);
  return b64encode(blob);
}

/** Decrypt a blob from encrypt(). Throws (wrong passphrase / corrupt) -> caller shows "can't unlock". */
export async function decrypt(blobB64: string, passphrase: string): Promise<string> {
  const blob = b64decode(blobB64);
  const salt = blob.slice(0, 16);
  const iv = blob.slice(16, 28);
  const ct = blob.slice(28);
  const key = await deriveKey(passphrase, salt);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, ct as BufferSource);
  return new TextDecoder().decode(pt);
}
