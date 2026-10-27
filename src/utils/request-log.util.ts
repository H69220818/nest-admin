/** Return a log-only URL copy without OAuth credentials, preserving other URL bytes. */
export function redactRequestUrl(url: string): string {
  const queryStart = url.indexOf('?')
  if (queryStart === -1)
    return url

  const fragmentStart = url.indexOf('#', queryStart)
  const queryEnd = fragmentStart === -1 ? url.length : fragmentStart
  const query = url.slice(queryStart + 1, queryEnd).split('&').map((parameter) => {
    const key = parameter.split('=', 1)[0]
    let decodedKey: string
    try {
      decodedKey = decodeURIComponent(key.replace(/\+/g, ' '))
    }
    catch {
      return parameter
    }
    return /^(?:code|state)$/i.test(decodedKey) ? `${key}=[REDACTED]` : parameter
  }).join('&')

  return url.slice(0, queryStart + 1) + query + url.slice(queryEnd)
}
