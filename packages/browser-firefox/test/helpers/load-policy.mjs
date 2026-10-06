import fs from "node:fs";
import vm from "node:vm";

/**
 * policy.js ships as a classic extension script (the package is "type": "module"), so evaluate it the way
 * Firefox does and read the global it registers. Results are cloned into this realm so strict deep-equality works.
 */
export function loadPolicy() {
  const sandbox = { URL };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(new URL("../../runtime/companion/policy.js", import.meta.url), "utf8"), sandbox);
  const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
  const wrapped = {};
  for (const [key, value] of Object.entries(sandbox.ZameryPolicy)) {
    wrapped[key] = typeof value === "function" ? (...args) => clone(value(...args)) : clone(value);
  }
  return wrapped;
}
