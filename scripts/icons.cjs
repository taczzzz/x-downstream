const fs = require("node:fs/promises");
const path = require("node:path");
const { dependency } = require("./runtime.cjs");
const sharp = dependency("sharp");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" rx="34" fill="#173e2d"/><path d="M64 28v68m-25-25 25 25 25-25" stroke="#a3f3cd" stroke-width="9" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
(async () => {
  const directory = path.join(__dirname, "../extension/icons");
  await fs.mkdir(directory, { recursive: true });
  for (const size of [16, 48, 128]) await sharp(Buffer.from(svg)).resize(size, size).png().toFile(path.join(directory, `${size}.png`));
})();
