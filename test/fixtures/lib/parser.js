// Parses "key=value" lines into an object.
function parseConfig(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    out[key] = value;
  }
  return out;
}

module.exports = { parseConfig };
