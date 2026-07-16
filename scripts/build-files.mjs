import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export async function writeFileIfChanged(filename, contents) {
  const next = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  const current = await readFile(filename).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });

  if (current?.equals(next)) return false;

  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, next);
  return true;
}
