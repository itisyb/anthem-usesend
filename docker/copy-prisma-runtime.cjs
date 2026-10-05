// Copy the installed, lockfile-resolved Prisma dependency closure. pnpm's
// symlinks cannot be copied as isolated directories without their targets.
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { createHash } = require("node:crypto");
const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error("Usage: copy-prisma-runtime source-package destination");
const copied = new Map();

function locate(name, from) {
  const resolver = createRequire(path.join(from, "package.json"));
  for (const directory of resolver.resolve.paths(name) || []) {
    const candidate = path.join(directory, name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return fs.realpathSync(candidate);
  }
  throw new Error(`Missing installed Prisma dependency: ${name}`);
}

function copyPackage(directory) {
  const real = fs.realpathSync(directory);
  if (copied.has(real)) return copied.get(real);
  const target = path.join(destination, "node_modules/.prisma-runtime", createHash("sha256").update(real).digest("hex").slice(0, 20));
  copied.set(real, target);
  fs.cpSync(real, target, { recursive: true, dereference: true, filter: (file) => file !== path.join(real, "node_modules") });
  const manifest = JSON.parse(fs.readFileSync(path.join(real, "package.json"), "utf8"));
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
    let dependency;
    try { dependency = locate(name, real); }
    catch (error) { if (manifest.optionalDependencies?.[name]) continue; throw error; }
    const dependencyTarget = copyPackage(dependency);
    const link = path.join(target, "node_modules", name);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(path.relative(path.dirname(link), dependencyTarget), link, "dir");
  }
  return target;
}
const root = copyPackage(path.resolve(source));
const link = path.join(destination, "node_modules/prisma");
fs.mkdirSync(path.dirname(link), { recursive: true });
fs.symlinkSync(path.relative(path.dirname(link), root), link, "dir");
process.stdout.write(`Copied Prisma and ${copied.size - 1} installed dependency packages\n`);
