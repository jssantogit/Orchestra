const OPERATIONAL_KEYS = Object.freeze([
  "PATH",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
  "WINDIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
]);

function copyPresent(target, source, key) {
  const value = source?.[key];
  if (typeof value === "string") target[key] = value;
}

export function buildDelegationProcessEnvironment({
  source = process.env,
  providerKeys = [],
  extra = {},
} = {}) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("DELEGATION_ENV_SOURCE_INVALID");
  }
  if (!Array.isArray(providerKeys) || providerKeys.some((key) => typeof key !== "string" || !key)) {
    throw new TypeError("DELEGATION_ENV_KEYS_INVALID");
  }
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) {
    throw new TypeError("DELEGATION_ENV_EXTRA_INVALID");
  }

  const environment = {};
  for (const key of OPERATIONAL_KEYS) copyPresent(environment, source, key);
  for (const key of providerKeys) copyPresent(environment, source, key);
  for (const [key, value] of Object.entries(extra)) {
    if (typeof value === "string") environment[key] = value;
  }
  environment.ORCHESTRA_DELEGATION_ACTIVE = "1";
  environment.ORCHESTRA_DELEGATION_DEPTH = "1";
  return environment;
}
