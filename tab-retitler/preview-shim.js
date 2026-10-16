// Lets options.html open as an ordinary web page, for working on its design
// outside Chrome's extension system. Inside the extension it does nothing.

if (!globalThis.chrome?.storage) {
  const KEY = "tab-retitler-preview";
  const read = () => {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
  };
  const granted = new Set();
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key) => (key in read() ? { [key]: read()[key] } : {}),
        set: async (items) => localStorage.setItem(KEY, JSON.stringify({ ...read(), ...items })),
      },
    },
    permissions: {
      contains: async ({ origins }) => origins.every((o) => granted.has(o)),
      request: async ({ origins }) => (origins.forEach((o) => granted.add(o)), true),
    },
    runtime: {},
  };
}
