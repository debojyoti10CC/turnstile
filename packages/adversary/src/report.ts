export type Layer = 'contract' | 'server' | 'fuzz';

export interface AttackResult {
  attack: string;
  layer: Layer;
  expected: 'rejected' | 'accepted';
  actual: 'rejected' | 'accepted' | 'error';
  pass: boolean;
  detail?: string;
}

/** Runs an attack expected to be REJECTED (fn throwing/rejecting == correctly defended). */
export async function expectRejected(attack: string, layer: Layer, fn: () => Promise<unknown>): Promise<AttackResult> {
  try {
    await fn();
    return { attack, layer, expected: 'rejected', actual: 'accepted', pass: false, detail: 'attack succeeded -- no error was thrown' };
  } catch (err) {
    return { attack, layer, expected: 'rejected', actual: 'rejected', pass: true, detail: errMessage(err) };
  }
}

/** Runs a check expected to resolve to a falsy/rejecting outcome without throwing (e.g. a {ok:false} result object). */
export async function expectFalsy(attack: string, layer: Layer, fn: () => Promise<boolean>): Promise<AttackResult> {
  try {
    const ok = await fn();
    if (ok) {
      return { attack, layer, expected: 'rejected', actual: 'accepted', pass: false, detail: 'check returned true -- attack was accepted' };
    }
    return { attack, layer, expected: 'rejected', actual: 'rejected', pass: true };
  } catch (err) {
    // An unexpected crash while *evaluating* the check is not the same as
    // the system correctly rejecting the attack -- surface it distinctly.
    return { attack, layer, expected: 'rejected', actual: 'error', pass: false, detail: errMessage(err) };
  }
}

/** Runs a benign action expected to SUCCEED (a negative control -- proves the harness isn't just always failing). */
export async function expectAccepted(attack: string, layer: Layer, fn: () => Promise<unknown>): Promise<AttackResult> {
  try {
    await fn();
    return { attack, layer, expected: 'accepted', actual: 'accepted', pass: true };
  } catch (err) {
    return { attack, layer, expected: 'accepted', actual: 'rejected', pass: false, detail: errMessage(err) };
  }
}

function errMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 300 ? msg.slice(0, 300) + '…' : msg;
}
