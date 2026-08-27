// _shared/tokenCrypto.ts
// AES-256-GCM Verschlüsselung für Access-Tokens.
// Der Klartext-Token wird NUR hier reversibel gespeichert, damit er
// für wiederverwendete Reminder-Links erneut ausgelesen werden kann.
// Der Hash in access_tokens.token_hash bleibt zusätzlich bestehen und
// wird weiterhin für den eigentlichen Zugriffsvergleich genutzt.

function getKey(): Promise<CryptoKey> {
  const keyB64 = Deno.env.get('TOKEN_ENCRYPTION_KEY')
  if (!keyB64) {
    throw new Error('TOKEN_ENCRYPTION_KEY-Umgebungsvariable ist nicht gesetzt.')
  }
  const rawKey = Uint8Array.from(atob(keyB64), c => c.charCodeAt(0))
  if (rawKey.length !== 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY muss genau 32 Byte (base64-kodiert) lang sein.')
  }
  return crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export async function encryptToken(rawToken: string): Promise<string> {
  const key = await getKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(rawToken)
  )
  const combined = new Uint8Array(iv.length + ciphertext.byteLength)
  combined.set(iv, 0)
  combined.set(new Uint8Array(ciphertext), iv.length)
  return btoa(String.fromCharCode(...combined))
}

export async function decryptToken(encrypted: string): Promise<string> {
  const key = await getKey()
  const combined = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0))
  const iv = combined.slice(0, 12)
  const ciphertext = combined.slice(12)
  const plainBuffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
  return new TextDecoder().decode(plainBuffer)
}



