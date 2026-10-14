#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStableVersion } from "./versioning.mjs";

export function evaluateExistingPublication({ sha, tagSha = "", releaseExists = false, releaseSha = "" }) {
  const tagExists = Boolean(tagSha);
  if (tagExists && releaseExists) {
    if (!releaseSha || tagSha !== releaseSha) {
      return {
        action: "fail",
        tagExists: true,
        releaseExists: true,
        reason: `Published tag does not point to the release integration SHA (${releaseSha || "missing"})`,
      };
    }
    return { action: "noop", tagExists: true, releaseExists: true, reason: "already-published" };
  }
  if (!tagExists && releaseExists) {
    return { action: "fail", tagExists: false, releaseExists: true, reason: "GitHub Release exists without a corresponding tag" };
  }
  if (tagExists && tagSha !== sha) {
    return { action: "fail", tagExists: true, releaseExists: false, reason: `Existing tag points to a different SHA (${tagSha})` };
  }
  return { action: "publish", tagExists, releaseExists: false };
}

export function validatePublishAuthorization({ version, sha, ciConclusion, pullRequests = [] }) {
  try {
    parseStableVersion(version);
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  const tag = `v${version}`;
  const expectedHead = `release/${tag}`;
  if (ciConclusion !== "success") return { ok: false, tag, reason: `CI conclusion is ${ciConclusion || "missing"}` };
  if (!sha) return { ok: false, tag, reason: "Exact workflow SHA is missing" };

  const match = pullRequests.find((pr) =>
    Boolean(pr?.merged_at)
    && pr?.base?.ref === "main"
    && pr?.head?.ref === expectedHead
    && pr?.merge_commit_sha === sha
  );
  if (!match) {
    return { ok: false, tag, reason: `No merged ${expectedHead} pull request authorizes exact main SHA ${sha}` };
  }
  return { ok: true, tag, pullRequestNumber: match.number ?? null };
}

function argValue(argv, name) {
  const inline = argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function main() {
  const argv = process.argv.slice(2);
  const version = argValue(argv, "--version");
  const sha = argValue(argv, "--sha");
  const ciConclusion = argValue(argv, "--ci-conclusion");
  const prsFile = argValue(argv, "--prs-file");
  if (!version || !sha || !ciConclusion || !prsFile) throw new Error("Missing --version, --sha, --ci-conclusion, or --prs-file");
  const pullRequests = JSON.parse(readFileSync(resolve(prsFile), "utf8"));
  const result = validatePublishAuthorization({ version, sha, ciConclusion, pullRequests });
  if (!result.ok) throw new Error(result.reason);
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `tag=${result.tag}\n`, { flag: "a" });
  }
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  }
}
