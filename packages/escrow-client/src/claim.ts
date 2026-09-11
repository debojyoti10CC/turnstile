import type { AppClient } from '@algorandfoundation/algokit-utils/types/app-client';
import { channelBoxName, unsettledBoxName } from './boxes.js';
import { claimOpUpExtraFee, MAX_APP_CALL_FOREIGN_REFERENCES } from './fees.js';

export interface ClaimRow {
  channelId: Uint8Array;
  maxClaimable: bigint;
  signature: Uint8Array;
  totalClaimed: bigint;
}

export interface ClaimParams {
  appClient: AppClient;
  sender: string;
  rows: ClaimRow[];
  /** (receiver, assetId) per row's channel, needed to build the unsettled box refs. */
  receiverByChannel: (row: ClaimRow) => { receiver: string; asset: bigint };
}

/**
 * Submits a batch `claim()` call. Stale rows (total_claimed not advancing
 * the on-chain value) are on-chain no-ops, so retrying a batch is safe.
 *
 * The real limit on batch size is box references, not opcode budget (see
 * docs/DECISIONS.md): each row needs its channel's box, plus one shared
 * "unsettled" box per distinct receiver among the rows, and a single app
 * call may carry at most MAX_APP_CALL_FOREIGN_REFERENCES (8) box/account/
 * asset references combined. This function checks that exact bound rather
 * than a fixed row count, so callers sharing one receiver across rows (the
 * common settler case) can batch up to 7 rows, not just 4.
 */
export async function claimBatch(params: ClaimParams): Promise<bigint> {
  const { appClient, sender, rows } = params;
  if (rows.length === 0) throw new Error('claimBatch: rows must be non-empty');

  const claimsArg = rows.map((r) => [r.channelId, r.maxClaimable, r.signature, r.totalClaimed]);

  const boxNames = new Set<string>();
  const boxReferences: { appId: bigint; name: Uint8Array }[] = [];
  const pushBox = (name: Uint8Array) => {
    const key = Buffer.from(name).toString('hex');
    if (!boxNames.has(key)) {
      boxNames.add(key);
      boxReferences.push({ appId: appClient.appId, name });
    }
  };
  for (const row of rows) {
    const { receiver, asset } = params.receiverByChannel(row);
    pushBox(channelBoxName(row.channelId));
    pushBox(unsettledBoxName(receiver, asset));
  }

  if (boxReferences.length > MAX_APP_CALL_FOREIGN_REFERENCES) {
    throw new Error(
      `claimBatch: ${rows.length} rows need ${boxReferences.length} box references, ` +
        `exceeding MAX_APP_CALL_FOREIGN_REFERENCES (${MAX_APP_CALL_FOREIGN_REFERENCES}); ` +
        'chunk the batch or group rows by receiver before calling claimBatch',
    );
  }

  const result = await appClient.send.call({
    sender,
    method: 'claim',
    args: [claimsArg],
    extraFee: claimOpUpExtraFee(rows.length),
    boxReferences,
    populateAppCallResources: false,
    coverAppCallInnerTransactionFees: false,
  });
  return result.return as bigint;
}
