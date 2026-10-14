// Embeds schema.sql (+ any additive schema.<slice>.sql files, applied in name
// order) into a TS module so the Next.js server bundle and tests share one
// source of truth without filesystem lookups at runtime.
import fs from "node:fs";
const dir = new URL("../src/server/db/", import.meta.url);
const extra = fs.readdirSync(dir).filter((f) => /^schema\..+\.sql$/.test(f)).sort();
let sql = fs.readFileSync(new URL("schema.sql", dir), "utf8");
for (const f of extra) sql += `\n-- ===== ${f} =====\n` + fs.readFileSync(new URL(f, dir), "utf8");
const out = `// GENERATED from schema*.sql by scripts/gen-schema-module.mjs — do not edit.\nexport const SCHEMA_SQL = ${JSON.stringify(sql)};\n`;
fs.writeFileSync(new URL("schema.ts", dir), out);
console.log(`schema.ts regenerated (${1 + extra.length} file(s))`);
