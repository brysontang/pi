import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const distDirectory = join(packageDirectory, "dist");

rmSync(distDirectory, { force: true, recursive: true });
mkdirSync(distDirectory, { recursive: true });
copyFileSync(join(packageDirectory, "index.cjs"), join(distDirectory, "index.cjs"));
copyFileSync(join(packageDirectory, "index.d.ts"), join(distDirectory, "index.d.ts"));
