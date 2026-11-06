// Generates the typed @solana/kit client for the program from the Anchor IDL into src/program.
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFromRoot } from "codama";
import { rootNodeFromAnchor } from "@codama/nodes-from-anchor";
import { renderVisitor } from "@codama/renderers-js";

const idl = JSON.parse(readFileSync(new URL("../../target/idl/tic_tac_sol.json", import.meta.url)));
const out = mkdtempSync(join(tmpdir(), "codama-"));
await createFromRoot(rootNodeFromAnchor(idl)).accept(renderVisitor(out, { formatCode: false }));

const target = new URL("../src/program", import.meta.url).pathname;
rmSync(target, { recursive: true, force: true });
cpSync(join(out, "src/generated"), target, { recursive: true });
rmSync(out, { recursive: true, force: true });
console.log("generated src/program");
