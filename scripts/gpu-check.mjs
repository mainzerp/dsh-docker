#!/usr/bin/env node
/**
 * Verifies that headless Chromium in this container renders on the passed-through
 * host GPU instead of SwiftShader (CPU).
 *
 * Run from the repo checkout inside the container:
 *
 *   node scripts/gpu-check.mjs
 *
 * Exit code 0: at least one launch configuration reported a hardware renderer.
 * Exit code 1: software rendering only, or the device/userspace prerequisites
 *              are missing.
 *
 * Fallback for Chrome builds that refuse to use the GPU in headless mode
 * (`xvfb-run` ships in the image via the Playwright deps):
 *
 *   GPU_CHECK_HEADFUL=1 xvfb-run -a node scripts/gpu-check.mjs
 */

import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DRI_DIR = '/dev/dri';
const EGL_VENDOR_DIR = '/usr/share/glvnd/egl_vendor.d';
const VULKAN_ICD_DIR = '/usr/share/vulkan/icd.d';
const HEADFUL = process.env.GPU_CHECK_HEADFUL === '1';
const SOFTWARE_RE = /swiftshader|llvmpipe|softpipe|software|mesa offscreen/i;

const CANDIDATES = [
  { name: 'default (no extra flags)', args: [] },
  { name: 'angle + gl-egl (Mesa)', args: ['--use-gl=angle', '--use-angle=gl-egl'] },
  { name: 'angle + vulkan (ANV)', args: ['--use-angle=vulkan', '--enable-features=Vulkan'] },
  {
    name: 'angle + gl-egl, gpu sandbox off',
    args: ['--use-gl=angle', '--use-angle=gl-egl', '--disable-gpu-sandbox'],
  },
  {
    name: 'angle + vulkan, gpu sandbox off',
    args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--disable-gpu-sandbox'],
  },
];

/** Resolves the Playwright library: global install first, then local. */
async function loadChromium() {
  const candidates = [];
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    candidates.push(join(globalRoot, 'playwright', 'index.mjs'));
  } catch {
    // npm unavailable - fall through to the bare specifier
  }
  candidates.push('playwright');
  for (const candidate of candidates) {
    try {
      const specifier = candidate.startsWith('/') ? pathToFileURL(candidate).href : candidate;
      const mod = await import(specifier);
      if (mod.chromium) return mod.chromium;
    } catch {
      // try the next candidate
    }
  }
  throw new Error('Playwright not found (tried global npm root and the local package)');
}

function listJsonFiles(dir) {
  if (!existsSync(dir)) return null;
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();
}

function reportDevices() {
  console.log('[1] DRM devices');
  if (!existsSync(DRI_DIR)) {
    console.log(`    FAIL  ${DRI_DIR} is missing - no device passthrough in this container`);
    return false;
  }
  let ok = true;
  const entries = readdirSync(DRI_DIR).sort();
  if (entries.length === 0) {
    console.log(`    FAIL  ${DRI_DIR} is empty`);
    return false;
  }
  for (const name of entries) {
    const path = join(DRI_DIR, name);
    const st = statSync(path);
    const mode = (st.mode & 0o777).toString(8).padStart(3, '0');
    let access = 'rw';
    try {
      accessSync(path, constants.R_OK | constants.W_OK);
    } catch {
      access = 'DENIED';
      ok = false;
    }
    console.log(`    ${access === 'rw' ? 'ok  ' : 'FAIL'}  ${path} mode=${mode} uid=${st.uid} gid=${st.gid} access=${access}`);
  }
  if (!ok) {
    console.log('    hint  add the owning GID to group_add in the compose file (host: stat -c %g /dev/dri/*)');
  }
  return ok;
}

function reportUserspace() {
  console.log('[2] GPU userspace');
  let ok = true;
  const egl = listJsonFiles(EGL_VENDOR_DIR);
  if (egl === null) {
    console.log(`    FAIL  ${EGL_VENDOR_DIR} missing - install libegl1/libegl-mesa0 (ANGLE GL backend unavailable)`);
    ok = false;
  } else {
    console.log(`    ok    EGL vendor libraries: ${egl.join(', ') || '(none)'}`);
    if (egl.length === 0) ok = false;
  }
  const icd = listJsonFiles(VULKAN_ICD_DIR);
  if (icd === null) {
    console.log(`    FAIL  ${VULKAN_ICD_DIR} missing - install mesa-vulkan-drivers (only SwiftShader available)`);
    ok = false;
  } else {
    console.log(`    ok    Vulkan ICDs: ${icd.join(', ') || '(none)'}`);
    if (icd.length === 0) ok = false;
  }
  const dri = '/usr/lib/x86_64-linux-gnu/dri';
  if (existsSync(dri)) {
    const drivers = readdirSync(dri).filter((name) => /^(iris|i915|crocus)_dri\.so$/.test(name));
    console.log(`    ok    Mesa DRI drivers: ${drivers.join(', ') || '(none - install libgl1-mesa-dri)'}`);
  }
  return ok;
}

async function probe(chromium, args, url) {
  const browser = await chromium.launch({ headless: !HEADFUL, args });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    const info = await page.evaluate(async () => {
      const out = { webgl: null, webgpu: null };
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      if (gl) {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        const vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
        const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        out.webgl = `${vendor} | ${renderer}`;
      }
      if (!navigator.gpu) {
        out.webgpu = 'unavailable';
      } else {
        try {
          const adapter = await navigator.gpu.requestAdapter();
          out.webgpu = adapter
            ? `${adapter.info?.vendor ?? '?'} / ${adapter.info?.architecture ?? '?'}`
            : 'no adapter';
        } catch (error) {
          out.webgpu = `error: ${error.message}`;
        }
      }
      return out;
    });
    return { version: browser.version(), ...info };
  } finally {
    await browser.close();
  }
}

async function main() {
  const chromium = await loadChromium();
  console.log(`Chromium: ${chromium.executablePath()}`);
  console.log(`Mode: ${HEADFUL ? 'headful (needs xvfb-run)' : 'headless'}\n`);

  const devicesOk = reportDevices();
  const userspaceOk = reportUserspace();

  // Serve a page over http://127.0.0.1 so WebGPU sees a secure context.
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>gpu-check</title><canvas id="c"></canvas>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;

  console.log('\n[3] Chromium launch configurations');
  const results = [];
  try {
    for (const candidate of CANDIDATES) {
      let result;
      try {
        result = await probe(chromium, candidate.args, url);
      } catch (error) {
        result = { error: error.message.split('\n')[0] };
      }
      const hardware = Boolean(result.webgl) && !SOFTWARE_RE.test(result.webgl);
      results.push({ ...candidate, ...result, hardware });
      console.log(`    ${hardware ? 'GPU ' : 'SW  '} ${candidate.name}`);
      if (result.error) {
        console.log(`         error: ${result.error}`);
      } else {
        console.log(`         chromium ${result.version}`);
        console.log(`         webgl:  ${result.webgl ?? 'no context'}`);
        console.log(`         webgpu: ${result.webgpu}`);
      }
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const working = results.filter((r) => r.hardware);
  console.log('\n[4] Result');
  if (!devicesOk) {
    console.log('    FAIL  no usable DRM device (see [1])');
  }
  if (!userspaceOk) {
    console.log('    FAIL  incomplete GPU userspace (see [2])');
  }
  if (working.length > 0) {
    console.log(`    ok    hardware rendering with: ${working.map((r) => r.name).join(' | ')}`);
    console.log('    note  pass these args to Playwright: chromium.launch({ args: [...] })');
    process.exitCode = 0;
  } else {
    console.log('    FAIL  every configuration fell back to software rendering');
    console.log('    hints: check [1]/[2] above; retry with GPU_CHECK_HEADFUL=1 xvfb-run -a node scripts/gpu-check.mjs;');
    console.log('           see README "GPU passthrough (Intel iGPU)" for the flag fallbacks');
    process.exitCode = 1;
  }
}

await main();
