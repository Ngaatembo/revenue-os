import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createOAuthState,
  decryptRefreshToken,
  encryptRefreshToken,
  hashOAuthState,
} from '../googleSheetsCrypto.ts'

const key = '0123456789abcdef'.repeat(4)

test('OAuth state is high entropy, URL-safe, and hashed deterministically', async () => {
  const a = createOAuthState()
  const b = createOAuthState()
  assert.match(a, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(a, b)
  assert.equal(await hashOAuthState(a), await hashOAuthState(a))
  assert.notEqual(await hashOAuthState(a), await hashOAuthState(b))
  await assert.rejects(() => hashOAuthState('short'))
})

test('refresh tokens round-trip with authenticated AES-GCM encryption', async () => {
  const token = 'test-refresh-token-do-not-log'
  const encryptedA = await encryptRefreshToken(token, key)
  const encryptedB = await encryptRefreshToken(token, key)
  assert.match(encryptedA, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  assert.notEqual(encryptedA, encryptedB, 'fresh nonce should produce distinct ciphertext')
  assert.equal(await decryptRefreshToken(encryptedA, key), token)
  await assert.rejects(() => decryptRefreshToken(encryptedA, 'f'.repeat(64)))
  const parts = encryptedA.split('.')
  const tampered = parts[0] + '.' + parts[1] + '.' + (parts[2].startsWith('A') ? 'B' : 'A') + parts[2].slice(1)
  await assert.rejects(() => decryptRefreshToken(tampered, key))
})

test('encryption rejects malformed keys and invalid tokens/ciphertexts', async () => {
  await assert.rejects(() => encryptRefreshToken('token', 'not-a-key'))
  await assert.rejects(() => encryptRefreshToken('', key))
  await assert.rejects(() => decryptRefreshToken('plaintext', key))
})
