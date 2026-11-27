import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ALL_SCHEMAS } from "../src/schemas/index.js";

const dir = join(import.meta.dirname, "..", "schemas");
mkdirSync(dir, { recursive: true });
for (const [name, schema] of Object.entries(ALL_SCHEMAS)) {
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(z.toJSONSchema(schema, { io: "input" }), null, 2) + "\n");
}
