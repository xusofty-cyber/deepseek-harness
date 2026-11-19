import { describe, expect, it } from 'vitest'
import { REDACTED, redactText, redactValue } from '../src/redact.ts'

describe('NILM log redaction', () => {
  it('masks mainland mobile numbers while keeping the operator-friendly prefix and suffix', () => {
    expect(redactText('联系人 13800138000，请回拨')).toBe('联系人 138****8000，请回拨')
    expect(redactText('138001380001')).toBe('138001380001')
  })

  it('masks labeled and raw OpenID values', () => {
    const openId = `o${'Abcdefghijklmnopqrstuvwxy12'.slice(0, 27)}`
    expect(openId).toHaveLength(28)
    expect(redactText(`openid=${openId}`)).toBe(`openid=${REDACTED}`)
    expect(redactText(`用户 ${openId} 已绑定`)).toBe(`用户 ${REDACTED} 已绑定`)
  })

  it('masks bearer tokens, authorization headers, API keys, and NILM signatures', () => {
    const text = [
      'authorization: Bearer eyJhbGciOiJIUzI1NiJ9',
      'apiKey=sk-live-abcdef123456',
      'x-nilm-signature: v1=0123456789abcdef0123456789abcdef',
      'plain v1=0123456789abcdef0123456789abcdef',
    ].join(' ')
    const masked = redactText(text)
    expect(masked).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(masked).not.toContain('sk-live-abcdef123456')
    expect(masked).not.toContain('0123456789abcdef0123456789abcdef')
    expect(masked).toContain('authorization: <redacted>')
    expect(masked).toContain('apiKey=<redacted>')
  })

  it('preserves ordinary business text and numbers', () => {
    const text = '租户 tenant-a 昨日用电 12000 kWh，峰段 08:00-11:00'
    expect(redactText(text)).toBe(text)
  })

  it('masks sensitive JSON fields without changing the surrounding structure', () => {
    const input = {
      tenantId: 'tenant-a',
      userRef: '13800138000',
      contact: { phone: '13900139000', openid: 'o123456789012345678901234567' },
      nested: [{ authorization: 'Bearer secret-token-value' }, 'ok'],
    }
    const masked = redactValue(input)
    expect(masked).toEqual({
      tenantId: 'tenant-a',
      userRef: '138****8000',
      contact: { phone: REDACTED, openid: REDACTED },
      nested: [{ authorization: REDACTED }, 'ok'],
    })
  })
})
