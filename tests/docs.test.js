import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { COMMANDS } from "../src/model/commands.js";

const requiredDocuments = ["README.md", "agent.md", "cluade.md"];

test("all public commands are documented in every required guide", async () => {
  for (const filename of requiredDocuments) {
    const document = await readFile(filename, "utf8");
    for (const [syntax] of COMMANDS) {
      assert.ok(document.includes(`auri ${syntax}`), `${filename} is missing: auri ${syntax}`);
    }
  }
});

test("the guides preserve the command-first and test-first contracts", async () => {
  const documents = await Promise.all(requiredDocuments.map((file) => readFile(file, "utf8")));
  assert.match(documents[0], /Test-driven workflow/);
  assert.match(documents[1], /Every actionable GUI control must call a command/);
  assert.match(documents[2], /Write the behavioral test first/);
});
