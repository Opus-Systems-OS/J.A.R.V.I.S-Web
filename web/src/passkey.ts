// Passkeys in the browser: signing in with one after the password, and
// making one from the Defenses panel. Binary fields travel as base64url.

import { webGet, webSend, web, request } from "./api";

/** What `/auth/login` returns instead of a cookie when a passkey is enrolled. */
export interface PasskeyStep {
  second_factor: "passkey";
  challenge: string;
  rp_id: string;
  credentials: string[];
}

export interface PasskeyRow {
  id: string;
  label: string;
  created_at: number;
}

const b64 = {
  enc: (b: ArrayBuffer | Uint8Array): string =>
    btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) : b)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, ""),
  dec: (s: string): Uint8Array<ArrayBuffer> => {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  },
};

export const passkeysSupported = (): boolean => typeof PublicKeyCredential !== "undefined";

/** Face ID / Touch ID (or a key), then the server's cookie. Throws on cancel. */
export async function signIn(step: PasskeyStep): Promise<void> {
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: b64.dec(step.challenge),
      rpId: step.rp_id,
      allowCredentials: step.credentials.map((id) => ({ type: "public-key", id: b64.dec(id) })),
      userVerification: "required",
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new DOMException("No passkey", "NotAllowedError");
  const r = cred.response as AuthenticatorAssertionResponse;
  await request("POST", "/auth/passkey", {
    challenge: step.challenge,
    id: cred.id,
    client_data_json: b64.enc(r.clientDataJSON),
    authenticator_data: b64.enc(r.authenticatorData),
    signature: b64.enc(r.signature),
  });
}

export const listPasskeys = (): Promise<PasskeyRow[]> => webGet<PasskeyRow[]>("passkeys");

export const removePasskey = (id: string): Promise<void> => webSend(`passkeys/${id}/remove`, {});

/** Make a passkey on this device and store it. Throws on cancel. */
export async function addPasskey(label: string): Promise<void> {
  const c = await web<{
    challenge: string;
    rp_id: string;
    rp_name: string;
    user_id: string;
    user_name: string;
    exclude: string[];
  }>("passkeys/begin", {});
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: b64.dec(c.challenge),
      rp: { id: c.rp_id, name: c.rp_name },
      user: { id: b64.dec(c.user_id), name: c.user_name, displayName: c.user_name },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      excludeCredentials: c.exclude.map((id) => ({ type: "public-key", id: b64.dec(id) })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new DOMException("No passkey", "NotAllowedError");
  const r = cred.response as AuthenticatorAttestationResponse;
  const key = r.getPublicKey();
  if (!key) throw new Error("This browser would not share the passkey's public key");
  await webSend("passkeys", {
    challenge: c.challenge,
    id: cred.id,
    client_data_json: b64.enc(r.clientDataJSON),
    public_key: b64.enc(key),
    label,
  });
}
