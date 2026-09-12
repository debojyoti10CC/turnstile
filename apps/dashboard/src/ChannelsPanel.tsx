import type { Channel, ChannelsResponse } from './api.js';

function short(addr: string): string {
  return addr.length > 10 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function withdrawCountdown(channel: Channel, withdrawDelaySeconds: number): string {
  if (channel.withdrawRequestedAt === 0) return '—';
  const finalizableAtMs = (channel.withdrawRequestedAt + withdrawDelaySeconds) * 1000;
  const remainingMs = finalizableAtMs - Date.now();
  if (remainingMs <= 0) return 'finalizable now';
  return `${Math.ceil(remainingMs / 1000)}s`;
}

export function ChannelsPanel({ data }: { data: ChannelsResponse | null }) {
  if (!data) {
    return <p className="muted">No channel data yet — waiting for the merchant's /debug/channels.</p>;
  }
  if (data.channels.length === 0) {
    return <p className="muted">No channels opened yet on app {data.appId} ({data.network}).</p>;
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Channel</th>
            <th>Payer</th>
            <th>Receiver</th>
            <th>Deposit (balance)</th>
            <th>Charged</th>
            <th>Signed max</th>
            <th>Claimed</th>
            <th>Exposure</th>
            <th>Withdraw</th>
          </tr>
        </thead>
        <tbody>
          {data.channels.map((c) => {
            // Exposure is what the receiver has actually earned but not yet
            // claimed on-chain (chargedCumulativeAmount - totalClaimed), not
            // the pre-authorized ceiling the client signed (signedMaxClaimable) --
            // that ceiling is shown separately in its own column.
            const exposure = BigInt(c.chargedCumulativeAmount) - BigInt(c.totalClaimed);
            return (
              <tr key={c.channelId}>
                <td title={c.channelId}>{short(c.channelId)}</td>
                <td title={c.channelConfig.payer}>{short(c.channelConfig.payer)}</td>
                <td title={c.channelConfig.receiver}>{short(c.channelConfig.receiver)}</td>
                <td>{c.balance}</td>
                <td>{c.chargedCumulativeAmount}</td>
                <td>{c.signedMaxClaimable}</td>
                <td>{c.totalClaimed}</td>
                <td className={exposure > 0n ? 'exposure-positive' : ''}>{exposure.toString()}</td>
                <td>{withdrawCountdown(c, data.withdrawDelaySeconds)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
