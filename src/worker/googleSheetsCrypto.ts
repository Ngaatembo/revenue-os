/**
 * Cryptographic primitives for the Google Sheets connector.
 *
 * The encryption key must be a 32-byte key encoded as 64 hexadecimal characters.
 * Ciphertext format: v1.<base64url nonce>.<base64url AES-GCM ciphertext>.
 * Never log state values, tokens, keys, or ciphertext.
 */
const encoder = new TextEncoder()
const KEY_HEX = /^[a-f0-9]{64}$/i

function decodeKey(hex: string): Uint8Array {
  if (!KEY_HEX.test(hex)) throw new Error('invalid_encryption_key')
  const bytes = new Uint8Array(32)
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid_ciphertext')
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

/** Generates a high-entropy OAuth state value; persist only its SHA-256 hash. */
export function createOAuthState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return toBase64Url(bytes)
}

export async function hashOAuthState(state: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(state)) throw new Error('invalid_oauth_state')
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(state))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Encrypts a provider refresh token using AES-256-GCM with a fresh random nonce. */
export async function encryptRefreshToken(token: string, keyHex: string): Promise<string> {
  if (!token || token.length > 16_384) throw new Error('invalid_refresh_token')
  const key = await crypto.subtle.importKey('raw', decodeKey(keyHex).buffer as ArrayBuffer, 'AES-GCM', false, ['encrypt'])
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce.buffer as ArrayBuffer }, key, encoder.encode(token).buffer as ArrayBuffer)
  return `v1.${toBase64Url(nonce)}.${toBase64Url(new Uint8Array(ciphertext))}`
}

/** Decrypts only the supported authenticated format; authentication failures throw. */
export async function decryptRefreshToken(encrypted: string, keyHex: string): Promise<string> {
  const parts = encrypted.split('.')
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('invalid_ciphertext')
  const nonce = fromBase64Url(parts[1])
  const ciphertext = fromBase64Url(parts[2])
  if (nonce.length !== 12 || ciphertext.length < 16 || ciphertext.length > 16_512) {
    throw new Error('invalid_ciphertext')
  }
  const key = await crypto.subtle.importKey('raw', decodeKey(keyHex).buffer as ArrayBuffer, 'AES-GCM', false, ['decrypt'])
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce.buffer as ArrayBuffer }, key, ciphertext.buffer as ArrayBuffer)
  return new TextDecoder().decode(plaintext)
}
