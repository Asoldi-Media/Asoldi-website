// Loads the claims data files once. The files are plain JSON next to this module. The hub and the
// Maker carry the same data files; a parity test compares them.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));

export const CLAIMS_DATA_FILES = Object.freeze(["regulated-substances.json", "disease-terms.nb.json", "disease-terms.en.json", "eu-health-claims.json"]);

let cache = null;

function readJson(name) {
  return JSON.parse(readFileSync(path.join(dir, name), "utf8"));
}

export function loadClaimsData() {
  if (!cache) {
    cache = Object.freeze({
      substances: readJson("regulated-substances.json"),
      diseasesNb: readJson("disease-terms.nb.json"),
      diseasesEn: readJson("disease-terms.en.json"),
      euClaims: readJson("eu-health-claims.json"),
    });
  }
  return cache;
}
