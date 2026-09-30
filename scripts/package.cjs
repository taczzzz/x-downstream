const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const root = path.join(__dirname, "..");
// Chrome deduplicates a shared filename even when manifest entries target
// different worlds. Ship a generated copy for MAIN and core.js for ISOLATED.
fs.copyFileSync(path.join(root, "extension/core.js"), path.join(root, "extension/page-core.js"));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension/manifest.json")));
const required = new Set(["manifest.json", manifest.action.default_popup, "popup.js", "popup.css"]);
if (manifest.background?.service_worker) required.add(manifest.background.service_worker);
for (const script of manifest.content_scripts) for (const file of script.js || []) required.add(file);
for (const file of Object.values(manifest.icons)) required.add(file);
for (const file of required) if (!fs.existsSync(path.join(root, "extension", file))) throw new Error(`Missing packaged file: ${file}`);
fs.mkdirSync(path.join(root, "dist"), { recursive: true });
const zip = path.join(root, `dist/x-downstream-${manifest.version}.zip`);
if (fs.existsSync(zip)) fs.unlinkSync(zip);
execFileSync("zip", ["-q", zip, ...required], { cwd: path.join(root, "extension") });
console.log(zip);
