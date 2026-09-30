const path = require("node:path");
function dependency(name) {
  try { return require(name); } catch {
    const bundled = process.env.DOWNSTREAM_NODE_MODULES || path.join(require("node:os").homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules");
    return require(path.join(bundled, name));
  }
}
module.exports = { dependency };
