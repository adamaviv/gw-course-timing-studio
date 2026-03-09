const DETAIL_URL_ALLOWED_HOSTS = new Set(['bulletin.gwu.edu', 'my.gwu.edu']);

function safeParseUrl(rawValue, baseUrl) {
  const text = String(rawValue ?? '').trim();
  if (!text) {
    return null;
  }

  try {
    return baseUrl ? new URL(text, baseUrl) : new URL(text);
  } catch {
    return null;
  }
}

export function sanitizeDetailUrl(rawValue, baseUrl = null) {
  const parsedUrl = safeParseUrl(rawValue, baseUrl);
  if (!parsedUrl) {
    return '';
  }

  if (parsedUrl.username || parsedUrl.password || parsedUrl.port) {
    return '';
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  if (!DETAIL_URL_ALLOWED_HOSTS.has(hostname)) {
    return '';
  }

  if (parsedUrl.protocol === 'http:') {
    parsedUrl.protocol = 'https:';
  }

  if (parsedUrl.protocol !== 'https:') {
    return '';
  }

  parsedUrl.hash = '';
  return parsedUrl.toString();
}

export { DETAIL_URL_ALLOWED_HOSTS };
