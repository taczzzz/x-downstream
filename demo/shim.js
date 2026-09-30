// Local demonstration only; never shipped in the extension.
(() => {
  const listeners = new Set();
  const data = { enabled: true };
  globalThis.chrome = { storage: {
    local: {
      get: async defaults => ({ ...defaults, ...data }),
      set: async values => {
        const changes = {};
        for (const [key, value] of Object.entries(values)) { changes[key] = { oldValue: data[key], newValue: value }; data[key] = value; }
        for (const listener of listeners) listener(changes, "local");
      }
    },
    onChanged: { addListener: callback => listeners.add(callback) }
  } };
})();
