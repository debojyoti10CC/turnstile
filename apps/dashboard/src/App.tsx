import { useEffect, useState } from 'react';
import { fetchAdversaryReport, fetchBench, fetchChannels, MERCHANT_URL, type AdversaryResult, type BenchRun, type ChannelsResponse } from './api.js';
import { ChannelsPanel } from './ChannelsPanel.js';
import { BenchPanel } from './BenchPanel.js';
import { AdversaryPanel } from './AdversaryPanel.js';

const CHANNELS_POLL_MS = 3000;
const STATIC_POLL_MS = 10000; // bench.json / report.json only change when those CLIs are rerun

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
        <span className={`status ${connected ? 'ok' : 'bad'}`}>
          {connected ? `connected — ${MERCHANT_URL}` : `cannot reach ${MERCHANT_URL}`}
        </span>
      </header>

      <section>
        <h2>Channels {channels ? `(app ${channels.appId}, ${channels.network})` : ''}</h2>
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
