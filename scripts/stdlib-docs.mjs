#!/usr/bin/env node
// Generate docs/stdlib.md from the doc strings of the built-in functions.
// Run `npm run build` first, or use `npm run docs`.
import { writeFile } from "node:fs/promises";
import { builtins } from "../dist/src/runtime/stdlib.js";

const GROUPS = [
  ["Core", ["print", "str", "repr", "num", "int", "type", "len", "assert", "assert_eq", "error", "clock"]],
  [
    "Lists",
    [
      "push",
      "pop",
      "insert",
      "remove_at",
      "first",
      "last",
      "slice",
      "reverse",
      "contains",
      "index_of",
      "sort",
      "list",
      "range",
      "flatten",
      "unique",
      "take",
      "drop",
      "chunks",
      "zip",
      "enumerate",
    ],
  ],
  ["Higher-order", ["map", "filter", "reduce", "each", "find", "any", "all", "count", "sum", "min", "max", "group_by"]],
  [
    "Strings",
    [
      "split",
      "join",
      "upper",
      "lower",
      "trim",
      "starts_with",
      "ends_with",
      "replace",
      "chars",
      "lines",
      "pad_left",
      "pad_right",
      "code",
      "char",
      "fixed",
    ],
  ],
  ["Maps", ["keys", "values", "entries", "has", "get", "delete", "merge", "copy"]],
  [
    "Math",
    [
      "abs",
      "floor",
      "ceil",
      "round",
      "sqrt",
      "sin",
      "cos",
      "atan2",
      "log",
      "random",
      "random_int",
      "choice",
      "shuffle",
    ],
  ],
  ["Option and Result", ["unwrap", "unwrap_or", "is_some", "is_ok"]],
  ["JSON", ["to_json", "from_json"]],
];

const { natives } = builtins();
const byName = new Map(natives.filter((n) => !n.name.startsWith("__")).map((n) => [n.name, n]));
const seen = new Set();
let md = `# Standard library

This page is generated from the doc strings in \`src/runtime/stdlib.ts\` by \`npm run docs\`. Do not edit it by hand.

Every function can be called two ways. \`len(xs)\` and \`xs.len()\` are the same call: \`value.f(args)\` passes
\`value\` as the first argument. Pipelines do the same: \`xs |> map(f)\` is \`map(xs, f)\`.

Constants: \`PI\`, \`E\`, \`INF\`. Constructors: \`Some(value)\`, \`None\`, \`Ok(value)\`, \`Err(error)\`.

`;
const row = (n) => {
  const [signature, ...rest] = n.doc.split(": ");
  return `| \`${signature}\` | ${rest.join(": ").replace(/\|/g, "\\|")} |\n`;
};
for (const [title, names] of GROUPS) {
  md += `## ${title}\n\n| Function | Description |\n| --- | --- |\n`;
  for (const name of names) {
    const n = byName.get(name);
    if (!n) throw new Error(`unknown builtin ${name}`);
    seen.add(name);
    md += row(n);
  }
  md += "\n";
}
const rest = [...byName.values()].filter((n) => !seen.has(n.name));
if (rest.length) {
  md += `## Other\n\n| Function | Description |\n| --- | --- |\n`;
  for (const n of rest) md += row(n);
}
await writeFile("docs/stdlib.md", md);
console.log(`docs/stdlib.md: ${byName.size} functions`);
