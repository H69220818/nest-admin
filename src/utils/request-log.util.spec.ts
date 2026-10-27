import { redactRequestUrl } from './request-log.util'

describe('redactRequestUrl', () => {
  it.each([
    ['/callback?code=secret&state=secret-state', '/callback?code=[REDACTED]&state=[REDACTED]'],
    ['/callback?CoDe=one&%73tAtE=two&code=three&state', '/callback?CoDe=[REDACTED]&%73tAtE=[REDACTED]&code=[REDACTED]&state=[REDACTED]'],
    ['/callback?code=hidden%26safe%3Dno&safe=keep%26code%3Dpublic%2Bvalue&empty=&tag=a&tag=b#section', '/callback?code=[REDACTED]&safe=keep%26code%3Dpublic%2Bvalue&empty=&tag=a&tag=b#section'],
    ['/callback?%ZZ=safe&safe=%ZZ&code=secret', '/callback?%ZZ=safe&safe=%ZZ&code=[REDACTED]'],
    ['/path&code=public', '/path&code=public'],
    ['/callback?postcode=public&statement=public+value', '/callback?postcode=public&statement=public+value'],
  ])('sanitizes %s without changing safe values', (url, expected) => {
    expect(redactRequestUrl(url)).toBe(expected)
  })
})
