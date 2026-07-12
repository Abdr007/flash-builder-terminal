#!/usr/bin/env node
/**
 * ER endpoint latency benchmark.
 *
 * Measures real getSlot RTT (the round-trip your trades pay for submit +
 * confirm) to the current ER endpoint plus any URLs you pass, so you can find
 * the fastest sequencer and point MAGIC_RPC_URL at it for the lowest latency.
 *
 *   node bench-er.mjs                                  # current endpoint only
 *   node bench-er.mjs https://your-asia-endpoint/ ...  # compare candidates
 *
 * Then set the winner:  MAGIC_RPC_URL=<fastest> magic
 */
const SAMPLES = 7;

async function currentEr() {
  if (process.env.MAGIC_RPC_URL) return process.env.MAGIC_RPC_URL;
  try {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const cfg = JSON.parse(fs.readFileSync(`${os.homedir()}/.magic/config.json`, 'utf8'));
    if (cfg.er_rpc_url) return cfg.er_rpc_url;
  } catch { /* ignore */ }
  return 'https://flashtrade.magicblock.app/';
}

async function sampleRtt(url) {
  const t0 = performance.now();
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] }),
      signal: AbortSignal.timeout(5000),
    });
    const j = await r.json();
    if (!r.ok || j.error) return { ms: performance.now() - t0, ok: false, note: `http ${r.status}` };
    return { ms: performance.now() - t0, ok: true, slot: j.result };
  } catch (e) {
    return { ms: performance.now() - t0, ok: false, note: (e.cause?.code || e.message || 'error').toString().slice(0, 30) };
  }
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

const urls = [...new Set([await currentEr(), ...process.argv.slice(2)])];
console.log(`\nBenchmarking ${urls.length} endpoint(s), ${SAMPLES} samples each (getSlot RTT)…\n`);

const results = [];
for (const url of urls) {
  const samples = [];
  let lastNote = '';
  for (let i = 0; i < SAMPLES; i++) {
    const s = await sampleRtt(url);
    if (s.ok) samples.push(s.ms); else lastNote = s.note;
  }
  if (samples.length === 0) {
    console.log(`  ✗ ${url}\n      unreachable (${lastNote})`);
    results.push({ url, med: Infinity });
  } else {
    const med = median(samples), min = Math.min(...samples);
    console.log(`  • ${url}\n      median ${med.toFixed(0)}ms   min ${min.toFixed(0)}ms   (${samples.length}/${SAMPLES} ok)`);
    results.push({ url, med });
  }
}

const ranked = results.filter((r) => r.med !== Infinity).sort((a, b) => a.med - b.med);
if (ranked.length) {
  const best = ranked[0];
  console.log(`\n  ⚡ fastest: ${best.url}  (${best.med.toFixed(0)}ms median)`);
  console.log(`     set it:  MAGIC_RPC_URL=${best.url} magic\n`);
}
