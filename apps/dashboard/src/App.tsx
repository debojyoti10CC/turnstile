import { useEffect, useState } from 'react';
import { fetchAdversaryReport, fetchBench, fetchChannels, MERCHANT_URL, type AdversaryResult, type BenchRun, type ChannelsResponse } from './api.js';
import { ChannelsPanel } from './ChannelsPanel.js';
import { BenchPanel } from './BenchPanel.js';
import { AdversaryPanel } from './AdversaryPanel.js';

const CHANNELS_POLL_MS = 3000;
const STATIC_POLL_MS = 10000; // bench.json / report.json only change when those CLIs are rerun

// CAIP-2 ids for Algorand MainNet/TestNet (first 32 chars of the url-safe b64
// genesis hash) -- mirrors @turnstile/core's CAIP2 constants. Anything else
// is LocalNet: its genesis hash is regenerated per `algokit localnet reset`,
// so there's no fixed id to match against.
const CAIP2_MAINNET = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k';
const CAIP2_TESTNET = 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe';

function networkLabel(caip2: string): string {
  if (caip2 === CAIP2_MAINNET) return 'Algorand MainNet';
  if (caip2 === CAIP2_TESTNET) return 'Algorand TestNet';
  return 'Algorand LocalNet';
}

export default function App() {
  const [channels, setChannels] = useState<ChannelsResponse | null>(null);
  const [bench, setBench] = useState<BenchRun[] | null>(null);
  const [adversary, setAdversary] = useState<AdversaryResult[] | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const data = await fetchChannels();
      if (!alive) return;
      setChannels(data);
      setConnected(data !== null);
    };
    poll();
    const id = setInterval(poll, CHANNELS_POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const [b, a] = await Promise.all([fetchBench(), fetchAdversaryReport()]);
      if (!alive) return;
      setBench(b);
      setAdversary(a);
    };
    poll();
    const id = setInterval(poll, STATIC_POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  return (
    <div className="app">
      <header>
        <h1>Turnstile</h1>
        <span className="subtitle">x402 batch-settlement for Algorand</span>
        {channels && (
          <span className={`network-badge ${networkLabel(channels.network).endsWith('MainNet') ? 'mainnet' : ''}`} title={channels.network}>
            {networkLabel(channels.network)}
          </span>
        )}
        <span className={`status ${connected ? 'ok' : 'bad'}`}>
          {connected ? `connected — ${MERCHANT_URL}` : `cannot reach ${MERCHANT_URL}`}
        </span>
      </header>

      <section>
        <h2>Channels {channels ? `(app ${channels.appId})` : ''}</h2>
        <ChannelsPanel data={channels} />
      </section>

      <section>
        <h2>Benchmark: batch-settlement vs. naive per-call baseline</h2>
        <BenchPanel data={bench} />
      </section>

      <section>
        <h2>Adversary suite</h2>
        <AdversaryPanel data={adversary} />
      </section>
    </div>
  );
}
