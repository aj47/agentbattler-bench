function replaceAll(content, value, replacement) {
  if (!value || value === replacement) return { content, replacements: 0 };
  const parts = content.split(value);
  return { content: parts.join(replacement), replacements: parts.length - 1 };
}

export function sanitizePublicTrace(content, { homeDirectory, username } = {}) {
  let sanitized = content;
  const counts = {};
  for (const [label, value, replacement] of [
    ['hostHomeDirectory', homeDirectory, '<redacted-home>'],
    ['hostUsername', username, '<redacted-user>'],
  ]) {
    const result = replaceAll(sanitized, value, replacement);
    sanitized = result.content;
    counts[label] = result.replacements;
  }
  return {
    content: sanitized,
    replacements: counts,
    totalReplacements: Object.values(counts).reduce((sum, count) => sum + count, 0),
  };
}
