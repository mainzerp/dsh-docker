#!/usr/bin/env node
/**
 * Generate the consumer package.json for the packed-tarball dsh install.
 *
 * The image build packs dsh from upstream source into three tarball dirs
 * (dsh family, vendor family, landlock-run) and installs them as `file:`
 * dependencies with plain npm — the same model as upstream's
 * scripts/release/verify-packed-install.ts (packedDependencies()).
 *
 * Usage: node make-consumer-manifest.mjs <out-package.json> <tarball-dir>...
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [, , outPath, ...dirs] = process.argv
if (outPath === undefined || dirs.length === 0) {
  console.error('usage: make-consumer-manifest.mjs <out-package.json> <tarball-dir>...')
  process.exit(1)
}

const dependencies = {}
for (const dir of dirs) {
  const absoluteDir = resolve(dir)
  const tarballs = readdirSync(absoluteDir).filter(name => name.endsWith('.tgz')).sort()
  if (tarballs.length === 0) {
    throw new Error(`${absoluteDir} holds no packed tarball`)
  }
  for (const filename of tarballs) {
    const tarball = join(absoluteDir, filename)
    // package/package.json is the manifest path inside every npm/pnpm tarball.
    const manifest = JSON.parse(
      execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' })
    )
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
      throw new Error(`${tarball}: package/package.json lacks name/version`)
    }
    dependencies[manifest.name] = pathToFileURL(tarball).href
  }
}

// Mirrors the verifier's entry check: without the dsh entry tarball there is
// no CLI to expose on PATH.
if (!('@deepseek-ai/dsh' in dependencies)) {
  throw new Error('@deepseek-ai/dsh is not among the packed tarballs')
}

const count = Object.keys(dependencies).length
writeFileSync(resolve(outPath), `${JSON.stringify({
  name: 'dsh-docker-consumer',
  version: '0.0.0',
  private: true,
  dependencies,
}, null, 2)}\n`)
console.log(`make-consumer-manifest: wrote ${outPath} with ${String(count)} file: dependencies (${dirname(resolve(outPath))})`)
