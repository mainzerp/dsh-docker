/**
 * Docker GPU patch for the bundled Playwright (fail-closed).
 *
 * Problem: in this container Chromium picks no hardware backend by itself.
 * Measured 2026-09-10 (Chrome for Testing 151, Debian 12 image, host Intel
 * Alder Lake-S GT1 / UHD 770 passed through as /dev/dri): a plain
 * `chromium.launch()` reports
 *   ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)
 * while the same launch with `--use-angle=gl-egl` reports
 *   ANGLE (Intel, Mesa Intel(R) UHD Graphics 770 (ADL-S GT1), OpenGL ES 3.2)
 * -- even though the device nodes are readable, /usr/share/vulkan/icd.d holds the
 * Intel ICDs and `vulkaninfo` lists the iGPU. No environment variable reaches
 * that decision (ANGLE_DEFAULT_PLATFORM and VK_ICD_FILENAMES were both measured
 * ineffective) and Playwright has no environment hook for extra Chromium
 * arguments, so the flag has to be injected here.
 *
 * What the patch does: appends `--use-angle=gl-egl` to Playwright's default
 * Chromium arguments, guarded by a runtime check that only fires when the GPU is
 * actually usable -- /dev/dri/renderD128 must be readable and writable by the
 * launching user. Consequences:
 *   - host with a passed-through GPU  -> hardware rendering by default
 *   - host without one, or a render node the user cannot open -> unchanged stock
 *     behavior (SwiftShader, still enabled by Playwright's
 *     `--enable-unsafe-swiftshader`, which this patch leaves alone)
 *   - a project that passes its own `--use-gl`/`--use-angle` wins; the patch then
 *     adds nothing.
 * Only the global Playwright install is patched. A project that installs its own
 * Playwright version into its workspace keeps stock behavior and must pass the
 * flag itself (see README "GPU passthrough (Intel iGPU)").
 *
 * NOTE: fails closed -- the image build greps this output for WARN and fails when
 *       the needle drifted (no site patched), a write failed, or the patched file
 *       no longer parses.
 *
 * Usage: node chromium-gpu-default.mjs <dir-containing-node_modules> [--check]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const argv = process.argv.slice(2)
const positional = argv.filter((arg) => !arg.startsWith('--'))
const root = resolve(positional[0] ?? process.cwd())
const nm = resolve(root, 'node_modules')
const checkOnly = argv.includes('--check')

const MARKER = 'dsh-docker:chromium-gpu-default'
const NEEDLE = 'chromeArguments.push("--enable-unsafe-swiftshader");'
// 6 = fs.constants.R_OK | fs.constants.W_OK; throws when the node is not openable.
const INJECT =
  ` /* ${MARKER} */ try {` +
  ' if (!args.some((a) => a.startsWith("--use-gl") || a.startsWith("--use-angle"))) {' +
  ' const fs = process.getBuiltinModule("node:fs");' +
  ' fs.accessSync("/dev/dri/renderD128", 6);' +
  ' chromeArguments.push("--use-angle=gl-egl"); }' +
  ' } catch {}'

function walkJs(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (name === '.bin' || name === '.cache') continue
    const p = join(dir, name)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) walkJs(p, out)
    else if (name.endsWith('.js')) out.push(p)
  }
  return out
}

// Only the Playwright packages can carry the needle; walking the whole
// node_modules tree (which includes the large dsh family) would be wasteful.
const playwrightRoots = existsSync(nm)
  ? readdirSync(nm)
      .filter((name) => name.includes('playwright'))
      .map((name) => join(nm, name))
  : []
if (playwrightRoots.length === 0) {
  console.log(`WARN: no playwright package found under ${nm}, skipping GPU patch`)
}

console.log('Searching for Chromium default-argument sites...')
let sites = 0
let files = 0
let alreadyPatched = 0
for (const bundle of playwrightRoots.flatMap((dir) => walkJs(dir))) {
  let text
  try {
    text = readFileSync(bundle, 'utf8')
  } catch {
    continue
  }
  if (!text.includes(NEEDLE) && !text.includes(MARKER)) continue
  if (text.includes(MARKER)) {
    console.log(`Already patched: ${bundle}`)
    alreadyPatched += 1
    continue
  }
  const count = text.split(NEEDLE).length - 1
  if (checkOnly) {
    console.log(`[check] would patch ${count} site(s) in ${bundle}`)
    sites += count
    files += 1
    continue
  }
  try {
    writeFileSync(bundle, text.split(NEEDLE).join(NEEDLE + INJECT))
    execFileSync(process.execPath, ['--check', bundle], { stdio: 'pipe' })
  } catch (err) {
    writeFileSync(bundle, text)
    console.log(`WARN: patching ${bundle} failed (${err.message.split('\n')[0]}), reverted`)
    continue
  }
  console.log(`Patched ${count} Chromium argument site(s) in ${bundle}`)
  sites += count
  files += 1
}

if (sites === 0 && alreadyPatched === 0) {
  console.log('WARN: no Chromium default-argument site found and no patch marker present (Playwright layout drifted)')
}

console.log(`Done: patched ${sites} site(s) in ${files} bundle(s), ${alreadyPatched} already patched`)
