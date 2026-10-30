import type { ReplayedWinner } from "@openfront/engine/WinnerReplay";
import type { PartialGameRecord } from "@openfront/shared/WireSchemas";
import { getTransferSolInstructionDataDecoder } from "@solana-program/system";
import {
  generateKeyPair,
  getAddressFromPublicKey,
  getTransactionDecoder,
  getBase64EncodedWireTransaction,
  partiallySignTransaction,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  address,
  signBytes,
} from "@solana/kit";
import canonicalize from "canonicalize";
import { generateKeyPairSync, verify } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeploymentDrain } from "../../src/frontpot/DeploymentDrain";
import { advanceLobby } from "../../src/frontpot/LobbyLifecycle";
import { MatchLedger } from "../../src/frontpot/MatchLedger";
import { MatchReview } from "../../src/frontpot/MatchReview";
import { Operations } from "../../src/frontpot/Operations";
import { DevnetPayments } from "../../src/frontpot/payments/DevnetPayments";
import {
  DevnetRPC,
  DevnetTransactions,
  acceptSignature,
} from "../../src/frontpot/payments/DevnetTransactions";
import {
  GENESIS_HASHES,
  type PaymentNetwork,
} from "../../src/frontpot/payments/Network";
import type { PaymentLimits } from "../../src/frontpot/payments/PaymentConfig";
import {
  paymentConfig,
  DEVNET_TREASURY,
} from "../../src/frontpot/payments/PaymentConfig";
import { PoolReconciliation } from "../../src/frontpot/payments/PoolReconciliation";
import { PrivyTransactionSigner } from "../../src/frontpot/payments/PrivyTransactionSigner";
import { LobbyStore } from "../../src/frontpot/Store";
const ledgers: MatchLedger[] = [];
afterEach(() => {
  for (const l of ledgers.splice(0)) l.close();
});
async function fixture(
  mode: "1v1" | "2v2" | "ffa" = "1v1",
  network: PaymentNetwork = "devnet",
  limits: PaymentLimits | undefined = network === "mainnet"
    ? {
        maxEntryLamports: 250_000_000,
        maxPoolLamports: 1_000_000_000,
        maxHeldLamports: 2_000_000_000,
        maxOpenPools: 2,
      }
    : undefined,
) {
  const keys = await Promise.all(
    Array.from({ length: 6 }, () => generateKeyPair()),
  );
  const addresses = await Promise.all(
    keys.map((k) => getAddressFromPublicKey(k.publicKey)),
  );
  const ledger = new MatchLedger(":memory:", network);
  ledgers.push(ledger);
  const store = new LobbyStore();
  const players = addresses
    .slice(0, mode === "1v1" ? 2 : 4)
    .map((a, i) => store.identity(`Player${i}`, a));
  const room = store.create(players[0], { mode, stake: "0.25" });
  players.slice(1).forEach((p) => store.join(p, room.id));
  ledger.open(room);
  let height = 100,
    finalized = false,
    hideStatuses = false,
    chainFailure = false,
    admissionsPaused = false,
    chain = GENESIS_HASHES[network],
    latestHash = "11111111111111111111111111111111",
    failSend = false;
  const sent = new Map<string, string>();
  const request = vi.fn(
    async (_url: unknown, init: RequestInit | undefined) => {
      const { method, params } = JSON.parse(init!.body as string);
      let result: unknown;
      if (method === "getGenesisHash") result = chain;
      else if (method === "getLatestBlockhash")
        result = {
          value: {
            blockhash: latestHash,
            lastValidBlockHeight: 200,
          },
        };
      else if (method === "isBlockhashValid")
        result = { context: { slot: 100 }, value: height <= 200 };
      else if (method === "getSignatureStatuses")
        result = {
          value: params[0].map((s: string) =>
            sent.has(s) && finalized && !hideStatuses
              ? {
                  err: chainFailure
                    ? { InstructionError: [0, "failure"] }
                    : null,
                  confirmationStatus: "finalized",
                }
              : null,
          ),
        };
      else if (method === "getBlockHeight") result = height;
      else if (method === "sendTransaction") {
        const tx = getTransactionDecoder().decode(
          Buffer.from(params[0], "base64"),
        );
        const { getSignatureFromTransaction } = await import("@solana/kit");
        result = getSignatureFromTransaction(tx);
        sent.set(result as string, params[0]);
        if (failSend)
          throw new Error(
            "Connection lost after network accepted the transfer",
          );
      } else if (method === "getSignaturesForAddress") {
        const all = [...sent.entries()]
          .reverse()
          .filter(([, wire]) =>
            getCompiledTransactionMessageDecoder()
              .decode(
                getTransactionDecoder().decode(Buffer.from(wire, "base64"))
                  .messageBytes,
              )
              .staticAccounts.includes(params[0]),
          )
          .map(([signature], i) => ({ signature, slot: 1000 - i }));
        const start = params[1].before
          ? all.findIndex((v) => v.signature === params[1].before) + 1
          : 0;
        result = all.slice(start, start + params[1].limit);
      } else if (method === "getTransaction") {
        const wire = sent.get(params[0]);
        if (!wire) result = null;
        else {
          const message = getCompiledTransactionMessageDecoder().decode(
            getTransactionDecoder().decode(Buffer.from(wire, "base64"))
              .messageBytes,
          );
          if (message.version !== 0) throw new Error("Expected v0 fixture");
          const pre = message.staticAccounts.map(() => 1_000_000_000_000),
            post = [...pre];
          if (message.version !== 0) throw new Error("Expected v0 fixture");
          for (const instruction of message.instructions) {
            if (
              message.staticAccounts[instruction.programAddressIndex] ===
              "ComputeBudget111111111111111111111111111111"
            )
              continue;
            const amount = Number(
              getTransferSolInstructionDataDecoder().decode(instruction.data!)
                .amount,
            );
            post[instruction.accountIndices![0]] -= amount;
            post[instruction.accountIndices![1]] += amount;
          }
          result = {
            slot: 1000 - [...sent.keys()].reverse().indexOf(params[0]),
            transaction: [wire, "base64"],
            meta: { err: null, preBalances: pre, postBalances: post },
          };
        }
      } else if (method === "getBalance") {
        let amount = 0;
        for (const wire of sent.values()) {
          const message = getCompiledTransactionMessageDecoder().decode(
            getTransactionDecoder().decode(Buffer.from(wire, "base64"))
              .messageBytes,
          );
          if (message.version !== 0) throw new Error("Expected v0 fixture");
          for (const instruction of message.instructions) {
            if (
              message.staticAccounts[instruction.programAddressIndex] ===
              "ComputeBudget111111111111111111111111111111"
            )
              continue;
            const n = Number(
              getTransferSolInstructionDataDecoder().decode(instruction.data!)
                .amount,
            );
            if (
              message.staticAccounts[instruction.accountIndices![0]] ===
              params[0]
            )
              amount -= n;
            if (
              message.staticAccounts[instruction.accountIndices![1]] ===
              params[0]
            )
              amount += n;
          }
        }
        result = { value: amount };
      } else throw new Error(`Unexpected RPC ${method}`);
      return new Response(JSON.stringify({ result }));
    },
  );
  const rpc = new DevnetRPC(
    "https://rpc.invalid",
    request as typeof fetch,
    network,
  );
  const tx = new DevnetTransactions(ledger.db, rpc);
  const sign = async (index: number, transaction: string) =>
    getBase64EncodedWireTransaction(
      await partiallySignTransaction(
        [keys[index]],
        getTransactionDecoder().decode(Buffer.from(transaction, "base64")),
      ),
    );
  const signer = {
    sign: vi.fn((id: string, t: string) => sign(id === "pool" ? 4 : 5, t)),
  };
  const wallets = {
    find: vi.fn(async () => null),
    create: vi.fn(async (externalID: string) => ({
      id: "pool",
      address: addresses[4],
      externalID,
    })),
  };
  const service = () =>
    new DevnetPayments(
      ledger.db,
      tx,
      wallets,
      signer,
      { id: "payer", address: addresses[5] },
      DEVNET_TREASURY,
      () => {
        if (admissionsPaused) throw new Error("Admissions paused");
      },
      limits,
    );
  const payments = service();
  const fund = async (index: number) => {
    const prep = await payments.prepare(room, players[index]);
    await payments.submit(
      room.id,
      players[index],
      prep.entryID,
      await sign(index, prep.transaction!),
    );
    return prep;
  };
  const lock = () =>
    advanceLobby(
      room,
      players.map((p) => p.id),
      room.startsAt!,
      (r, seats) => {
        payments.lock(r, seats);
        return ledger.lock(r, seats);
      },
      payments.fundedIDs(room.id),
    );
  const verified = () => {
    ledger.verifying(room.id);
    const record = {
      info: {
        gameID: room.id,
        players: room.members.map((m, i) => ({
          clientID: `client-${i}`,
          persistentID: m.id,
        })),
      },
      turns: [],
    } as unknown as PartialGameRecord;
    const replay = {
      winner:
        mode === "2v2"
          ? ["team", "Red", "client-0", "client-2"]
          : ["player", "client-0"],
      tick: 100,
      allPlayersStats: {},
    } as ReplayedWinner;
    return ledger.settle(record, replay)!;
  };
  return {
    store,
    keys,
    addresses,
    ledger,
    players,
    room,
    payments,
    service,
    rpc,
    tx,
    signer,
    wallets,
    sign,
    fund,
    lock,
    verified,
    sent,
    request,
    pause: () => {
      admissionsPaused = true;
    },
    hideStatuses: (value: boolean) => {
      hideStatuses = value;
    },
    failOnChain: () => {
      chainFailure = true;
    },
    healChain: () => {
      chainFailure = false;
    },
    advanceBlock: () => {
      latestHash = addresses[4];
    },
    finalize: () => {
      finalized = true;
    },
    expire: () => {
      height = 201;
    },
    wrongChain: () => {
      chain = "mainnet";
    },
    loseResponse: () => {
      failSend = true;
    },
  };
}
function transfers(wire: string) {
  const msg = getCompiledTransactionMessageDecoder().decode(
    getTransactionDecoder().decode(Buffer.from(wire, "base64")).messageBytes,
  );
  if (msg.version !== 0) throw new Error("Expected a v0 transaction");
  return {
    payer: msg.staticAccounts[0],
    transfers: msg.instructions.map((i) => ({
      to: msg.staticAccounts[i.accountIndices![1]],
      lamports: Number(
        getTransferSolInstructionDataDecoder().decode(i.data!).amount,
      ),
    })),
  };
}
describe("integrated devnet payments (local RPC fixture, no network funds)", () => {
  it("uses a fresh blockhash with matching broadcast preflight", async () => {
    const f = await fixture();
    await f.fund(0);
    const calls = f.request.mock.calls.map(([, init]) =>
      JSON.parse(init!.body as string),
    );
    expect(calls.find((c) => c.method === "getLatestBlockhash").params).toEqual(
      [{ commitment: "confirmed" }],
    );
    expect(
      calls.find((c) => c.method === "sendTransaction").params[1]
        .preflightCommitment,
    ).toBe("confirmed");
  });
  it("drains a funded waiting match and waits for its full refund and ledger confirmation", async () => {
    const f = await fixture();
    await f.fund(0);
    f.finalize();
    await f.payments.tick();
    const drain = new DeploymentDrain(f.store, f.ledger, f.payments);
    drain.closeWaiting(() => {});
    expect(drain.snapshot(true)).toMatchObject({
      ready: false,
      activeGames: 0,
      waitingLobbies: 0,
      unsettledMatches: 1,
    });
    expect(f.ledger.get(f.room.id)).toMatchObject({
      state: "refund_pending",
      feeLamports: 0,
    });
    await f.payments.tick();
    await f.payments.tick();
    expect(f.payments.refundsComplete(f.room.id)).toBe(true);
    expect(drain.snapshot(true).ready).toBe(false);
    f.ledger.confirmPayment(f.room.id, "refunded");
    expect(drain.snapshot(true).ready).toBe(true);
    const outgoing = [...f.sent.values()]
      .map(transfers)
      .filter((t) => t.payer === f.addresses[5]);
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0].transfers).toEqual([
      { to: f.addresses[0], lamports: 250_000_000 },
    ]);
  });

  it("tracks an already issued deposit arriving after drain readiness and refunds it", async () => {
    const f = await fixture();
    const issued = await f.payments.prepare(f.room, f.players[0]);
    const signed = await f.sign(0, issued.transaction!);
    const drain = new DeploymentDrain(f.store, f.ledger, f.payments);
    drain.closeWaiting(() => {});
    expect(f.payments.refundsComplete(f.room.id)).toBe(true);
    f.ledger.confirmPayment(f.room.id, "refunded");
    expect(drain.snapshot(true).ready).toBe(true);
    await f.payments.submit(f.room.id, f.players[0], issued.entryID, signed);
    expect(drain.snapshot(true).ready).toBe(false);
    f.finalize();
    await f.payments.tick();
    await f.payments.tick();
    expect(f.payments.status(f.room.id, f.players[0].id).state).toBe(
      "refunded",
    );
    expect(drain.snapshot(true).ready).toBe(true);
  });
  it("recovers a held payout only from the original finalized signature without signing or sending again", async () => {
    const f = await fixture();
    await f.fund(0);
    await f.fund(1);
    f.finalize();
    await f.payments.tick();
    f.lock();
    const pool = f.verified();
    f.hideStatuses(true);
    const pending = await f.payments.settle(pool);
    f.expire();
    expect((await f.payments.settle(pool)).state).toBe("review");
    f.ledger.review(pool.matchID, "Payment needs review");
    const operations = new Operations(f.ledger.db, f.payments);
    const before = operations.snapshot();
    expect(before.counts.review).toBe(1);
    expect(JSON.stringify(before)).not.toContain('"transaction":');
    const signs = f.signer.sign.mock.calls.length,
      sends = f.sent.size;
    f.hideStatuses(false);
    await operations.recheck(
      `settlement:${pending.key}`,
      "administrator",
      "Check delayed payout",
    );
    expect(f.ledger.confirmRecoveredSettlement(pool.matchID)).toBe(true);
    expect(f.ledger.get(pool.matchID)).toMatchObject({
      state: "settled",
      signature: pending.submission!.signature,
    });
    expect(f.signer.sign).toHaveBeenCalledTimes(signs);
    expect(f.sent.size).toBe(sends);
    expect(operations.snapshot().audit[0]).toMatchObject({
      actor: "administrator",
      result: "finalized",
    });
    expect(f.ledger.confirmRecoveredSettlement(pool.matchID)).toBe(false);
  });
  it("restores held deposits and refunds after finality, while failed transfers stay held", async () => {
    const f = await fixture();
    const prepared = await f.fund(0);
    f.expire();
    await f.payments.tick();
    expect(f.payments.status(f.room.id, f.players[0].id).state).toBe("review");
    f.finalize();
    await f.payments.recheck(`deposit:${prepared.entryID}`);
    expect(f.payments.status(f.room.id, f.players[0].id).state).toBe("funded");
    // A failed finalized transaction never becomes funded or refunded.
    const g = await fixture();
    const second = await g.fund(0);
    g.finalize();
    g.failOnChain();
    await g.payments.tick();
    await g.payments.recheck(`deposit:${second.entryID}`);
    expect(g.payments.status(g.room.id, g.players[0].id).state).toBe("review");
    expect(g.tx.get(`deposit:${second.entryID}`)?.reviewReason).toBe(
      "transaction_failed",
    );
  });
  it("recovers an already-finalized refund without creating a second refund", async () => {
    const f = await fixture();
    const prepared = await f.fund(0);
    f.finalize();
    await f.payments.tick();
    f.payments.cancelEntry(f.room.id, f.players[0].id);
    f.hideStatuses(true);
    await f.payments.tick();
    f.expire();
    await f.payments.tick();
    expect(f.payments.status(f.room.id, f.players[0].id).state).toBe("review");
    const calls = f.signer.sign.mock.calls.length;
    f.hideStatuses(false);
    await f.payments.recheck(`refund:${prepared.entryID}`);
    await f.payments.tick();
    expect(f.payments.status(f.room.id, f.players[0].id).state).toBe(
      "refunded",
    );
    expect(f.signer.sign).toHaveBeenCalledTimes(calls);
  });
  it("pauses new deposit preparation, checks again after provisioning, and still accepts an issued signed deposit", async () => {
    const f = await fixture();
    const prepared = await f.payments.prepare(f.room, f.players[0]);
    f.pause();
    await expect(f.payments.prepare(f.room, f.players[1])).rejects.toThrow(
      "Admissions paused",
    );
    await f.payments.submit(
      f.room.id,
      f.players[0],
      prepared.entryID,
      await f.sign(0, prepared.transaction!),
    );
    f.finalize();
    await f.payments.tick();
    expect(f.payments.status(f.room.id, f.players[0].id).state).toBe("funded");
    const g = await fixture();
    g.wallets.create.mockImplementationOnce(async (externalID) => {
      g.pause();
      return { id: "pool", address: g.addresses[4], externalID };
    });
    await expect(g.payments.prepare(g.room, g.players[0])).rejects.toThrow(
      "Admissions paused",
    );
    expect(g.payments.status(g.room.id, g.players[0].id).state).toBe(
      "unfunded",
    );
  });
  it("records signing failures for administrators without exposing provider errors", async () => {
    const f = await fixture();
    await f.fund(0);
    await f.fund(1);
    f.finalize();
    await f.payments.tick();
    f.lock();
    const pool = f.verified();
    f.signer.sign.mockRejectedValueOnce(new Error("secret provider response"));
    await f.payments.settle(pool);
    const operations = new Operations(f.ledger.db, f.payments);
    const snapshot = operations.snapshot();
    expect(snapshot.counts.signingFailures).toBe(1);
    expect(snapshot.signingIssues[0].matchID).toBe(pool.matchID);
    expect(JSON.stringify(snapshot)).not.toContain("secret provider response");
  });
  it("accepts the full devnet genesis and rejects abbreviated or other network identifiers", async () => {
    for (const hash of [
      "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
      "EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
      "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
    ]) {
      const rpc = new DevnetRPC(
        "https://rpc.invalid",
        async () => new Response(JSON.stringify({ result: hash })),
      );
      if (hash === "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG")
        await expect(rpc.check()).resolves.toBeUndefined();
      else await expect(rpc.check()).rejects.toThrow("must be Solana devnet");
    }
  });
  it.each(["1v1", "2v2", "ffa"] as const)(
    "funds %s, freezes the roster, and atomically pays the verified winner(s) plus 1%%",
    async (mode) => {
      const f = await fixture(mode);
      for (let i = 0; i < f.players.length; i++) await f.fund(i);
      expect(f.payments.fundedIDs(f.room.id)).toEqual([]);
      f.finalize();
      await f.payments.tick();
      expect(f.lock()).toBe("locked");
      const p = f.verified();
      expect(p.state).toBe("payout_pending");
      const first = await f.payments.settle(p);
      expect(first.state).toBe("pending");
      expect(f.ledger.get(p.matchID)?.state).toBe("payout_pending");
      const settled = await f.payments.settle(p);
      expect(settled.state).toBe("confirmed");
      f.ledger.confirmPayment(
        p.matchID,
        "settled",
        settled.submission!.signature,
      );
      const wire = f.sent.get(settled.submission!.signature!)!;
      const t = transfers(wire);
      expect(t.payer).toBe(f.addresses[5]);
      expect(t.transfers[t.transfers.length - 1]).toEqual({
        to: DEVNET_TREASURY,
        lamports: p.poolLamports / 100,
      });
      expect(t.transfers.reduce((n, t) => n + t.lamports, 0)).toBe(
        p.poolLamports,
      );
      expect(t.transfers.slice(0, -1).map((t) => t.lamports)).toEqual(
        mode === "2v2" ? [495_000_000, 495_000_000] : [p.poolLamports * 0.99],
      );
      const calls = f.signer.sign.mock.calls.length;
      await f.payments.settle(p);
      expect(f.signer.sign).toHaveBeenCalledTimes(calls);
      expect(f.wallets.create).toHaveBeenCalledTimes(1);
    },
  );
  it("does not start with connected but unfunded players", async () => {
    const f = await fixture();
    await f.fund(0);
    f.finalize();
    await f.payments.tick();
    expect(f.lock()).toBe("expired");
    expect(f.ledger.get(f.room.id)?.state).toBe("waiting");
    expect(f.room.readyIDs).toEqual([f.players[0].id]);
    // Mirror the server's expiry handler; the funded entry is returned in full.
    f.payments.cancel(f.room.id);
    f.ledger.refund(f.room.id, "Not enough ready players. No platform fee.");
    await f.payments.tick();
    f.finalize();
    await f.payments.tick();
    await f.payments.tick();
    const status = f.payments.status(f.room.id, f.players[0].id);
    expect(status.state).toBe("refunded");
    expect(transfers(f.sent.get(status.refundSignature!)!).transfers).toEqual([
      { to: f.addresses[0], lamports: 250_000_000 },
    ]);
  });
  it("refunds a deposit that finalizes after the seat was cancelled", async () => {
    const f = await fixture();
    await f.fund(0);
    f.payments.cancelEntry(f.room.id, f.players[0].id);
    f.finalize();
    await f.payments.tick();
    await f.payments.tick();
    const status = f.payments.status(f.room.id, f.players[0].id);
    expect(status.state).toBe("refunded");
    expect(transfers(f.sent.get(status.refundSignature!)!).transfers).toEqual([
      { to: f.addresses[0], lamports: 250_000_000 },
    ]);
    expect(f.payments.fundedIDs(f.room.id)).toEqual([]);
  });
  it("recovers interrupted matches and reconciles a lost payout response without another transfer", async () => {
    const f = await fixture();
    await f.fund(0);
    await f.fund(1);
    f.finalize();
    await f.payments.tick();
    f.lock();
    const p = f.verified();
    f.loseResponse();
    await f.payments.settle(p);
    const calls = f.signer.sign.mock.calls.length;
    const restarted = f.service();
    restarted.recover((id) => f.ledger.get(id));
    const result = await restarted.settle(p);
    expect(result.state).toBe("confirmed");
    expect(f.signer.sign).toHaveBeenCalledTimes(calls);
    expect(f.sent.size).toBe(3);
  });
  it("refunds both entries after restart during play and preserves the pending refund status", async () => {
    const f = await fixture();
    await f.fund(0);
    await f.fund(1);
    f.finalize();
    await f.payments.tick();
    f.lock();
    f.ledger.recoverInterrupted();
    expect(f.ledger.get(f.room.id)?.state).toBe("refund_pending");
    const restarted = f.service();
    restarted.recover((id) => f.ledger.get(id));
    await restarted.tick();
    await restarted.tick();
    expect(restarted.refundsComplete(f.room.id)).toBe(true);
    expect(f.sent.size).toBe(4);
  });
  it("accepts a raw wallet signature but rejects tampered instructions and another wallet", async () => {
    const f = await fixture();
    const prep = await f.payments.prepare(f.room, f.players[0]);
    const tx = getTransactionDecoder().decode(
      Buffer.from(prep.transaction!, "base64"),
    );
    const raw = Buffer.from(
      await signBytes(f.keys[0].privateKey, tx.messageBytes),
    ).toString("base64");
    await expect(
      acceptSignature(prep.transaction!, raw, f.addresses[0]),
    ).resolves.toBeTruthy();
    const changed = await f.rpc.build(f.addresses[0], f.addresses[0], [
      { to: f.addresses[1], lamports: 250_000_000 },
    ]);
    await expect(
      f.payments.submit(
        f.room.id,
        f.players[0],
        prep.entryID,
        await f.sign(0, changed.transaction),
      ),
    ).rejects.toThrow("changed");
    await expect(
      f.payments.submit(f.room.id, f.players[1], prep.entryID, raw),
    ).rejects.toThrow("does not belong");
    expect(f.sent.size).toBe(0);
  });
  it("serializes simultaneous funding requests and uses one immutable deposit", async () => {
    const f = await fixture();
    const preps = await Promise.all(
      Array.from({ length: 3 }, () => f.payments.prepare(f.room, f.players[0])),
    );
    expect(new Set(preps.map((p) => p.entryID)).size).toBe(1);
    expect(f.wallets.create).toHaveBeenCalledTimes(1);
    const signed = await f.sign(0, preps[0].transaction!);
    await Promise.all(
      preps.map((p) =>
        f.payments.submit(f.room.id, f.players[0], p.entryID, signed),
      ),
    );
    expect(f.sent.size).toBe(1);
  });
  it("holds expired signatures for review and refuses a mainnet endpoint", async () => {
    const f = await fixture();
    await f.fund(0);
    f.expire();
    await f.payments.tick();
    expect(f.payments.status(f.room.id, f.players[0].id).state).toBe("review");
    f.wrongChain();
    await expect(f.rpc.check()).rejects.toThrow("devnet");
    await expect(f.payments.prepare(f.room, f.players[1])).rejects.toThrow(
      "devnet",
    );
  });
  it("does not enable payments through an app secret alone or accept incomplete mainnet setup", () => {
    expect(paymentConfig({})).toBeNull();
    expect(() =>
      paymentConfig({ PAYMENTS_MODE: "devnet", PRIVY_APP_SECRET: "test" }),
    ).toThrow("missing");
    expect(() => paymentConfig({ PAYMENTS_MODE: "mainnet" })).toThrow(
      "missing",
    );
  });
  it("signs canonical Privy requests including the expiry and binds the wallet endpoint", async () => {
    const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const secret = keys.privateKey
      .export({ type: "pkcs8", format: "der" })
      .toString("base64");
    const request = vi.fn(async (url: string, init: RequestInit) => {
      const h = init.headers as Record<string, string>;
      const payload = canonicalize({
        version: 1,
        method: "POST",
        url,
        headers: {
          "privy-app-id": h["privy-app-id"],
          "privy-request-expiry": h["privy-request-expiry"],
        },
        body: JSON.parse(init.body as string),
      })!;
      expect(
        verify(
          "sha256",
          Buffer.from(payload),
          keys.publicKey,
          Buffer.from(h["privy-authorization-signature"], "base64"),
        ),
      ).toBe(true);
      expect(Number(h["privy-request-expiry"])).toBeGreaterThan(Date.now());
      return new Response(
        JSON.stringify({
          method: "signTransaction",
          data: { encoding: "base64", signed_transaction: "fixture" },
        }),
      );
    });
    const signer = new PrivyTransactionSigner(
      "test-app",
      "test-only",
      `wallet-auth:${secret}`,
      request as typeof fetch,
    );
    expect(await signer.sign("pool-wallet", "unsigned")).toBe("fixture");
    expect(request.mock.calls[0][0]).toBe(
      "https://api.privy.io/v1/wallets/pool-wallet/rpc",
    );
  });
});

describe("mainnet transport with local fixtures only", () => {
  it.each(["ffa", "1v1", "2v2"] as const)(
    "settles %s exactly once with 1% treasury and separate network fees",
    async (mode) => {
      const f = await fixture(mode, "mainnet");
      for (let i = 0; i < f.players.length; i++) await f.fund(i);
      f.finalize();
      await f.payments.tick();
      f.lock();
      const pool = f.verified();
      expect(pool.network).toBe("mainnet");
      expect(pool.state).toBe("payout_pending");
      await f.payments.settle(pool);
      const result = await f.payments.settle(pool);
      expect(result.state).toBe("confirmed");
      f.ledger.confirmPayment(
        pool.matchID,
        "settled",
        result.submission!.signature,
      );
      const payout = transfers(f.sent.get(result.submission!.signature!)!);
      expect(payout.payer).toBe(f.addresses[5]);
      expect(payout.transfers[payout.transfers.length - 1]).toEqual({
        to: DEVNET_TREASURY,
        lamports: pool.poolLamports / 100,
      });
      expect(payout.transfers.slice(0, -1).map((t) => t.lamports)).toEqual(
        mode === "2v2"
          ? [495_000_000, 495_000_000]
          : [pool.poolLamports * 0.99],
      );
      expect(f.sent.size).toBe(f.players.length + 1);
      expect(f.wallets.create.mock.calls[0][0]).toMatch(/^match-mainnet-/);
      expect(f.payments.status(f.room.id, f.players[0].id)).toMatchObject({
        network: "mainnet",
        state: "paid",
      });
    },
  );
  it("refunds mainnet entries after interruption without charging a platform fee", async () => {
    const f = await fixture("1v1", "mainnet");
    await f.fund(0);
    await f.fund(1);
    f.finalize();
    await f.payments.tick();
    f.lock();
    f.ledger.recoverInterrupted();
    const restarted = f.service();
    restarted.recover((id) => f.ledger.get(id));
    await restarted.tick();
    await restarted.tick();
    expect(restarted.refundsComplete(f.room.id)).toBe(true);
    const outgoing = [...f.sent.values()]
      .map(transfers)
      .filter((t) => t.payer === f.addresses[5]);
    expect(outgoing).toHaveLength(2);
    expect(outgoing.flatMap((t) => t.transfers).map((t) => t.lamports)).toEqual(
      [250_000_000, 250_000_000],
    );
    expect(f.ledger.get(f.room.id)?.feeLamports).toBe(0);
  });
  it("rejects switching a mainnet RPC to another network before signing", async () => {
    const f = await fixture("1v1", "mainnet");
    f.wrongChain();
    await expect(f.fund(0)).rejects.toThrow("must be Solana mainnet");
    expect(f.signer.sign).not.toHaveBeenCalled();
    expect(f.wallets.create).not.toHaveBeenCalled();
  });
  it("reserves unsigned entries atomically so concurrent funding cannot exceed exposure", async () => {
    const f = await fixture("1v1", "mainnet", {
      maxEntryLamports: 250_000_000,
      maxPoolLamports: 250_000_000,
      maxHeldLamports: 250_000_000,
      maxOpenPools: 1,
    });
    const results = await Promise.allSettled(
      f.players.map((p) => f.payments.prepare(f.room, p)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    f.payments.cancelEntry(f.room.id, f.players[0].id);
    await expect(f.payments.prepare(f.room, f.players[1])).rejects.toThrow(
      "funding limit",
    );
    expect(f.sent.size).toBe(0);
  });
  it("rejects entries above the configured wager limit before creating a wallet", async () => {
    const f = await fixture("1v1", "mainnet", {
      maxEntryLamports: 100_000_000,
      maxPoolLamports: 1_000_000_000,
      maxHeldLamports: 2_000_000_000,
      maxOpenPools: 2,
    });
    await expect(f.fund(0)).rejects.toThrow("wager limit");
    expect(f.wallets.create).not.toHaveBeenCalled();
  });
});

describe("recorded failed transfer recovery", () => {
  it.each(["devnet", "mainnet"] as const)(
    "retries a finalized failed payout on %s with unchanged terms and one successful payment",
    async (network) => {
      const f = await fixture("1v1", network);
      await f.fund(0);
      await f.fund(1);
      f.finalize();
      await f.payments.tick();
      f.lock();
      const pool = f.verified();
      const original = await f.payments.settle(pool);
      f.failOnChain();
      expect((await f.payments.settle(pool)).state).toBe("review");
      f.ledger.review(pool.matchID, "Payout failed");
      const jobID = `settlement:${original.key}`;
      const before = f.tx.get(jobID)!;
      const ops = new Operations(f.ledger.db, f.payments);
      f.advanceBlock();
      await ops.retryFailed(jobID, "admin", "Fee payer replenished");
      expect(f.tx.get(jobID)).toMatchObject({ state: "pending", attempt: 2 });
      expect(f.tx.get(jobID)!.signature).not.toBe(before.signature);
      expect(transfers(f.tx.get(jobID)!.transaction)).toEqual(
        transfers(before.transaction),
      );
      expect(
        f.ledger.db.prepare("SELECT signature FROM chain_attempts").all(),
      ).toEqual([{ signature: before.signature }]);
      f.healChain();
      const restarted = f.service();
      await restarted.advanceRecovery(pool.matchID);
      await restarted.advanceRecovery(pool.matchID);
      expect(f.ledger.confirmRecoveredSettlement(pool.matchID)).toBe(true);
      expect(f.ledger.get(pool.matchID)?.state).toBe("settled");
      const count = f.signer.sign.mock.calls.length;
      await expect(
        ops.retryFailed(jobID, "admin", "Try payment again"),
      ).rejects.toThrow();
      expect(f.signer.sign).toHaveBeenCalledTimes(count);
    },
  );
  it("never replaces an expired unknown payout or changes its recipient", async () => {
    const f = await fixture("1v1", "mainnet");
    await f.fund(0);
    await f.fund(1);
    f.finalize();
    await f.payments.tick();
    f.lock();
    const pool = f.verified();
    f.hideStatuses(true);
    const result = await f.payments.settle(pool);
    f.expire();
    await f.payments.settle(pool);
    const id = `settlement:${result.key}`,
      old = f.tx.get(id)!;
    f.advanceBlock();
    const count = f.signer.sign.mock.calls.length;
    await expect(f.payments.retryFailed(id)).rejects.toThrow(
      "finalized failed",
    );
    expect(f.tx.get(id)?.signature).toBe(old.signature);
    expect(f.signer.sign).toHaveBeenCalledTimes(count);
    f.hideStatuses(false);
    f.failOnChain();
    await expect(
      f.tx.retryFailed(
        id,
        { id: "pool", address: f.addresses[4] },
        { id: "payer", address: f.addresses[5] },
        [{ to: f.addresses[1], lamports: 500_000_000 }],
        f.signer,
      ),
    ).rejects.toThrow("differs");
    expect(f.signer.sign).toHaveBeenCalledTimes(count);
  });
  it("recovers a failed full refund and a crash immediately after replacement persistence", async () => {
    const f = await fixture("1v1", "mainnet");
    const prep = await f.fund(0);
    f.finalize();
    await f.payments.tick();
    f.payments.cancelEntry(f.room.id, f.players[0].id);
    await f.payments.tick();
    f.failOnChain();
    await f.payments.tick();
    expect(f.payments.status(f.room.id, f.players[0].id).state).toBe("review");
    const id = `refund:${prep.entryID}`;
    f.advanceBlock();
    // Persist the replacement, then emulate process exit before entry update.
    await f.tx.retryFailed(
      id,
      { id: "pool", address: f.addresses[4] },
      { id: "payer", address: f.addresses[5] },
      [{ to: f.addresses[0], lamports: 250_000_000 }],
      f.signer,
    );
    f.healChain();
    const restart = f.service();
    await restart.tick();
    await restart.tick();
    expect(restart.status(f.room.id, f.players[0].id).state).toBe("refunded");
    expect(transfers(f.tx.get(id)!.transaction).transfers).toEqual([
      { to: f.addresses[0], lamports: 250_000_000 },
    ]);
  });
});

async function adjustedDeposit(
  f: Awaited<ReturnType<typeof fixture>>,
  wire: string,
  hash = f.addresses[2],
) {
  const tx = getTransactionDecoder().decode(Buffer.from(wire, "base64"));
  const m = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if (m.version !== 0) throw new Error("Expected v0");
  const data = Buffer.alloc(5);
  data[0] = 2;
  data.writeUInt32LE(200_000, 1);
  return f.sign(
    0,
    getBase64EncodedWireTransaction({
      ...tx,
      messageBytes: getCompiledTransactionMessageEncoder().encode({
        ...m,
        lifetimeToken: hash,
        header: {
          ...m.header,
          numReadonlyNonSignerAccounts:
            m.header.numReadonlyNonSignerAccounts + 1,
        },
        staticAccounts: [
          ...m.staticAccounts,
          address("ComputeBudget111111111111111111111111111111"),
        ],
        instructions: [
          { programAddressIndex: m.staticAccounts.length, data },
          ...m.instructions,
        ],
      }) as typeof tx.messageBytes,
    }),
  );
}

describe("wallet-adjusted deposit lifecycle", () => {
  it("persists only one signed deposit across retries, restart, and refund", async () => {
    const f = await fixture("1v1", "mainnet");
    const prepared = await f.payments.prepare(f.room, f.players[0]);
    const signed = await adjustedDeposit(f, prepared.transaction!);
    const second = await adjustedDeposit(
      f,
      prepared.transaction!,
      f.addresses[3],
    );
    await Promise.all(
      [signed, second].map((wire) =>
        f.payments.submit(f.room.id, f.players[0], prepared.entryID, wire),
      ),
    );
    expect(f.sent.size).toBe(1);
    const saved = [...f.sent.values()][0];
    expect(saved).toBe(signed);
    f.finalize();
    const restart = f.service();
    restart.recover((id) => f.ledger.get(id));
    await restart.tick();
    await restart.tick();
    expect(restart.status(f.room.id, f.players[0].id).state).toBe("refunded");
    expect(f.sent.size).toBe(2);
    const refund = f.tx.get(`refund:${prepared.entryID}`)!;
    expect(transfers(refund.transaction).transfers).toEqual([
      { to: f.addresses[0], lamports: 250_000_000 },
    ]);
  });
  it("recovers a finalized adjusted deposit from history after its blockhash expired", async () => {
    const f = await fixture("1v1", "mainnet");
    const prepared = await f.payments.prepare(f.room, f.players[0]);
    const signed = await adjustedDeposit(f, prepared.transaction!);
    const { getSignatureFromTransaction } = await import("@solana/kit");
    const signature = getSignatureFromTransaction(
      getTransactionDecoder().decode(Buffer.from(signed, "base64")),
    );
    f.sent.set(signature, signed);
    f.finalize();
    f.expire();
    const audit = new PoolReconciliation(f.ledger.db, f.rpc, (id, wire) =>
      f.payments.importExternalDeposit(id, wire),
    );
    await audit.scan(f.room.id);
    expect(f.payments.status(f.room.id, f.players[0].id)).toMatchObject({
      state: "funded",
      depositSignature: signature,
    });
    expect(audit.snapshot().issues).toEqual([]);
    expect(audit.snapshot().unmatched).toEqual([]);
    expect(f.sent.size).toBe(1);
  });
});

describe("pool history reconciliation", () => {
  it("recovers an exact issued deposit broadcast outside the submit endpoint", async () => {
    const f = await fixture("1v1", "mainnet"),
      prepared = await f.payments.prepare(f.room, f.players[0]);
    const signed = await f.sign(0, prepared.transaction!);
    const { getSignatureFromTransaction } = await import("@solana/kit");
    const signature = getSignatureFromTransaction(
      getTransactionDecoder().decode(Buffer.from(signed, "base64")),
    );
    f.sent.set(signature, signed);
    f.finalize();
    const audit = new PoolReconciliation(f.ledger.db, f.rpc, (id, wire) =>
      f.payments.importExternalDeposit(id, wire),
    );
    await audit.scan(f.room.id);
    expect(f.payments.status(f.room.id, f.players[0].id)).toMatchObject({
      state: "funded",
      depositSignature: signature,
    });
    expect(audit.snapshot().issues).toEqual([]);
    expect(audit.snapshot().unmatched).toEqual([]);
    await audit.scan(f.room.id);
    expect(f.sent.size).toBe(1);
  });
  it("records excess or unsolicited deposits without awarding a seat or adding them to the prize", async () => {
    const f = await fixture("1v1", "mainnet");
    await f.fund(0);
    f.finalize();
    await f.payments.tick();
    const manual = await f.rpc.build(f.addresses[1], f.addresses[1], [
      { to: f.addresses[4], lamports: 300_000_000 },
    ]);
    const signed = await f.sign(1, manual.transaction),
      { getSignatureFromTransaction } = await import("@solana/kit");
    const signature = getSignatureFromTransaction(
      getTransactionDecoder().decode(Buffer.from(signed, "base64")),
    );
    f.sent.set(signature, signed);
    const audit = new PoolReconciliation(f.ledger.db, f.rpc, (id, wire) =>
      f.payments.importExternalDeposit(id, wire),
    );
    await audit.scan(f.room.id);
    expect(audit.snapshot().unmatched).toEqual([
      {
        matchID: f.room.id,
        signature,
        slot: 1000,
        delta: "300000000",
        state: "unreviewed",
      },
    ]);
    expect(audit.snapshot().issues[0]).toMatchObject({
      balance: "550000000",
      expected: "250000000",
      difference: "300000000",
    });
    expect(f.payments.fundedIDs(f.room.id)).toEqual([f.players[0].id]);
    await audit.scan(f.room.id);
    expect(audit.snapshot().unmatched).toHaveLength(1);
  });
  it("does not read or import pool transfers from another cluster", async () => {
    const f = await fixture("1v1", "mainnet");
    await f.payments.prepare(f.room, f.players[0]);
    f.wrongChain();
    const importer = vi.fn(async () => true),
      audit = new PoolReconciliation(f.ledger.db, f.rpc, importer);
    await expect(audit.scan(f.room.id)).rejects.toThrow("incomplete");
    expect(importer).not.toHaveBeenCalled();
    expect(audit.snapshot().issues[0].error).toBe(true);
  });
});

describe("exclusive use of deposit receipts", () => {
  function gate() {
    let resolve!: () => void;
    const promise = new Promise<void>((ready) => {
      resolve = ready;
    });
    return { promise, resolve };
  }
  async function unclaimedDeposit(additionalSurplus = false) {
    const f = await fixture("1v1", "mainnet");
    await f.fund(0);
    f.finalize();
    await f.payments.tick();
    if (additionalSurplus) {
      const extra = await f.rpc.build(f.addresses[2], f.addresses[2], [
        { to: f.addresses[4], lamports: 300_000_000 },
      ]);
      const signed = await f.sign(2, extra.transaction);
      const { getSignatureFromTransaction } = await import("@solana/kit");
      f.sent.set(
        getSignatureFromTransaction(
          getTransactionDecoder().decode(Buffer.from(signed, "base64")),
        ),
        signed,
      );
    }
    const wire = await f.rpc.build(f.addresses[1], f.addresses[1], [
      { to: f.addresses[4], lamports: 250_000_000 },
    ]);
    const signed = await f.sign(1, wire.transaction);
    const { getSignatureFromTransaction } = await import("@solana/kit");
    const signature = getSignatureFromTransaction(
      getTransactionDecoder().decode(Buffer.from(signed, "base64")),
    );
    f.sent.set(signature, signed);
    const audit = new PoolReconciliation(f.ledger.db, f.rpc, (id, tx) =>
      f.payments.importExternalDeposit(id, tx),
    );
    await audit.scan(f.room.id);
    return { ...f, signed, signature, audit };
  }

  it("cannot reuse a returned transfer as a newly issued entry after restart", async () => {
    const f = await unclaimedDeposit();
    await f.payments.returns.request(f.room.id, f.signature);
    await f.payments.tick();
    expect(f.tx.get(`return:${f.signature}`)?.state).toBe("finalized");
    f.advanceBlock();
    const restarted = f.service();
    const entry = await restarted.prepare(f.room, f.players[1]);
    await expect(
      restarted.submit(f.room.id, f.players[1], entry.entryID, f.signed),
    ).rejects.toThrow("return");
    expect(f.tx.get(`deposit:${entry.entryID}`)).toBeNull();
    expect(restarted.fundedIDs(f.room.id)).toEqual([f.players[0].id]);
    expect(f.audit.expected(f.room.id)).toBe(250_000_000n);
  });

  it.each(["entry", "return"] as const)(
    "only the %s claim wins overlapping submission and return requests",
    async (winner) => {
      const f = await unclaimedDeposit(true);
      const balanceReached = gate();
      const releaseBalance = gate();
      const request = f.request.getMockImplementation()!;
      f.request.mockImplementation(async (url, init) => {
        const result = await request(url, init);
        if (JSON.parse(String(init?.body)).method === "getBalance") {
          balanceReached.resolve();
          await releaseBalance.promise;
        }
        return result;
      });
      const returning = f.payments.returns.request(f.room.id, f.signature).then(
        (job) => ({ job, error: null }),
        (error: Error) => ({ job: null, error }),
      );
      await balanceReached.promise;
      f.advanceBlock();
      const entry = await f.payments.prepare(f.room, f.players[1]);
      const persistReached = gate();
      const releasePersist = gate();
      if (winner === "return") {
        const persist = f.tx.persist.bind(f.tx);
        vi.spyOn(f.tx, "persist").mockImplementationOnce(async (id, wire) => {
          persistReached.resolve();
          await releasePersist.promise;
          return persist(id, wire);
        });
      }
      const submitting = f.payments
        .submit(f.room.id, f.players[1], entry.entryID, f.signed)
        .then(
          (status) => ({ status, error: null }),
          (error: Error) => ({ status: null, error }),
        );
      if (winner === "return") {
        await persistReached.promise;
        releaseBalance.resolve();
        expect((await returning).error).toBeNull();
        releasePersist.resolve();
        expect((await submitting).error?.message).toContain("return");
        expect(f.tx.get(`deposit:${entry.entryID}`)).toBeNull();
        expect(f.tx.get(`return:${f.signature}`)).not.toBeNull();
      } else {
        expect((await submitting).status?.state).toBe("funded");
        releaseBalance.resolve();
        expect((await returning).error?.message).toContain("already recorded");
        expect(f.tx.get(`return:${f.signature}`)).toBeNull();
        expect(f.payments.returns.has(f.signature)).toBe(false);
      }
    },
  );

  it("reserves a receipt even when signing its return fails before broadcast", async () => {
    const f = await unclaimedDeposit();
    f.signer.sign.mockRejectedValueOnce(new Error("signer unavailable"));
    await expect(
      f.payments.returns.request(f.room.id, f.signature),
    ).rejects.toThrow("signer unavailable");
    expect(f.tx.get(`return:${f.signature}`)).toBeNull();
    f.advanceBlock();
    const restarted = f.service();
    const entry = await restarted.prepare(f.room, f.players[1]);
    await expect(
      restarted.submit(f.room.id, f.players[1], entry.entryID, f.signed),
    ).rejects.toThrow("return");
    expect(await restarted.importExternalDeposit(f.room.id, f.signed)).toBe(
      false,
    );
    await restarted.tick();
    await restarted.tick();
    expect(f.tx.get(`return:${f.signature}`)?.state).toBe("finalized");
    expect(restarted.fundedIDs(f.room.id)).toEqual([f.players[0].id]);
  });

  it("fails closed if a restored database contains conflicting entry and return claims", async () => {
    const f = await unclaimedDeposit();
    await f.payments.returns.request(f.room.id, f.signature);
    const id = "deposit:legacy-conflicting-receipt";
    // Simulate a pre-correction snapshot; do not silently discard either obligation.
    f.ledger.db.prepare("INSERT INTO chain_jobs(id,body) VALUES(?,?)").run(
      id,
      JSON.stringify({
        id,
        transaction: f.signed,
        signature: f.signature,
        lastValidBlockHeight: 200,
        state: "finalized",
      }),
    );
    const sent = f.sent.size;
    expect(() => f.service()).toThrow(
      "reconciliation is required before startup",
    );
    expect(f.tx.get(id)).not.toBeNull();
    expect(f.payments.returns.has(f.signature)).toBe(true);
    expect(f.sent.size).toBe(sent);
  });

  it("routes a blockhash-adjusted issued entry through entry reconciliation", async () => {
    const f = await unclaimedDeposit();
    f.advanceBlock();
    const entry = await f.payments.prepare(f.room, f.players[1]);
    const signedCount = f.signer.sign.mock.calls.length;
    await expect(
      f.payments.returns.request(f.room.id, f.signature),
    ).rejects.toThrow("issued match entry");
    expect(f.signer.sign).toHaveBeenCalledTimes(signedCount);
    await f.payments.submit(f.room.id, f.players[1], entry.entryID, f.signed);
    expect(f.payments.fundedIDs(f.room.id)).toHaveLength(2);
    expect(f.tx.get(`return:${f.signature}`)).toBeNull();
  });

  it("does not discard a second equal transfer while the first entry is confirming", async () => {
    const f = await fixture("1v1", "mainnet");
    const issued = await f.fund(0);
    f.advanceBlock();
    const extra = await f.rpc.build(f.addresses[0], f.addresses[0], [
      { to: f.addresses[4], lamports: 250_000_000 },
    ]);
    const signed = await f.sign(0, extra.transaction);
    const { getSignatureFromTransaction } = await import("@solana/kit");
    const signature = getSignatureFromTransaction(
      getTransactionDecoder().decode(Buffer.from(signed, "base64")),
    );
    f.sent.set(signature, signed);
    f.finalize();
    const originalSignature = f.tx.get(`deposit:${issued.entryID}`)!.signature;
    const audit = new PoolReconciliation(f.ledger.db, f.rpc, (id, tx) =>
      f.payments.importExternalDeposit(id, tx),
    );
    await audit.scan(f.room.id);
    expect(audit.snapshot().unmatched).toEqual([
      expect.objectContaining({ signature, delta: "250000000" }),
    ]);
    expect(f.tx.get(`deposit:${issued.entryID}`)!.signature).toBe(
      originalSignature,
    );
    await f.payments.tick();
    await f.payments.returns.request(f.room.id, signature);
    await f.payments.tick();
    expect(f.tx.get(`return:${signature}`)?.state).toBe("finalized");
    expect(f.payments.fundedIDs(f.room.id)).toEqual([f.players[0].id]);
  });
});

describe("returns of unmatched deposits", () => {
  async function manualDeposit(extraInstruction = false) {
    const f = await fixture("1v1", "mainnet");
    await f.fund(0);
    f.finalize();
    await f.payments.tick();
    const wire = await f.rpc.build(f.addresses[1], f.addresses[1], [
      { to: f.addresses[4], lamports: 300_000_000 },
      ...(extraInstruction
        ? [{ to: f.addresses[0], lamports: 1_000_000 }]
        : []),
    ]);
    const signed = await f.sign(1, wire.transaction);
    const { getSignatureFromTransaction } = await import("@solana/kit");
    const signature = getSignatureFromTransaction(
      getTransactionDecoder().decode(Buffer.from(signed, "base64")),
    );
    f.sent.set(signature, signed);
    const audit = new PoolReconciliation(f.ledger.db, f.rpc, (id, tx) =>
      f.payments.importExternalDeposit(id, tx),
    );
    await audit.scan(f.room.id);
    return { ...f, audit, signature };
  }
  it("returns only the excess deposit to its signed sender, preserves the prize and recovers after restart", async () => {
    const f = await manualDeposit();
    const ops = new Operations(f.ledger.db, f.payments);
    await ops.returnUnmatched(
      f.room.id,
      f.signature,
      f.addresses[0],
      "Return accidental extra transfer",
    );
    const job = f.tx.get(`return:${f.signature}`)!;
    expect(transfers(job.transaction).transfers).toEqual([
      { to: f.addresses[1], lamports: 300_000_000 },
    ]);
    expect(transfers(job.transaction).payer).toBe(f.addresses[5]);
    expect(f.payments.fundedIDs(f.room.id)).toEqual([f.players[0].id]);
    expect(f.audit.snapshot().unmatched[0].state).toBe("pending");
    const count = f.sent.size;
    const restart = f.service();
    await restart.tick();
    await restart.returns.request(f.room.id, f.signature);
    expect(f.sent.size).toBe(count);
    expect(f.tx.get(job.id)!.state).toBe("finalized");
    await f.audit.scan(f.room.id);
    expect(f.audit.snapshot().unmatched).toEqual([]);
    expect(f.audit.snapshot().issues).toEqual([]);
    expect(
      f.ledger.db.prepare("SELECT action,result FROM operation_audit").get(),
    ).toMatchObject({ action: "return_unmatched", result: "pending" });
  });
  it("holds ambiguous transfers and never signs them", async () => {
    const f = await manualDeposit(true),
      count = f.signer.sign.mock.calls.length;
    await expect(
      f.payments.returns.request(f.room.id, f.signature),
    ).rejects.toThrow("manual review");
    expect(f.signer.sign).toHaveBeenCalledTimes(count);
    expect(
      f.ledger.db.prepare("SELECT COUNT(*) AS n FROM unmatched_returns").get()!
        .n,
    ).toBe(0);
  });
  it("rejects mismatched balance evidence and issued entries without creating a return", async () => {
    const f = await manualDeposit(),
      count = f.signer.sign.mock.calls.length;
    f.ledger.db
      .prepare("UPDATE unmatched_pool_transactions SET delta='999999999'")
      .run();
    await expect(
      f.payments.returns.request(f.room.id, f.signature),
    ).rejects.toThrow("balance evidence");
    const deposit = f.payments.status(
      f.room.id,
      f.players[0].id,
    ).depositSignature!;
    f.ledger.db
      .prepare("INSERT INTO unmatched_pool_transactions VALUES(?,?,?,?)")
      .run(f.room.id, deposit, 999, "250000000");
    await expect(
      f.payments.returns.request(f.room.id, deposit),
    ).rejects.toThrow("eligible");
    expect(f.signer.sign).toHaveBeenCalledTimes(count);
  });
  it("refuses a return that would consume recorded match funds", async () => {
    const f = await manualDeposit(),
      original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (url, init) =>
      JSON.parse(init!.body as string).method === "getBalance"
        ? new Response(JSON.stringify({ result: { value: 300_000_000 } }))
        : original(url, init),
    );
    const count = f.signer.sign.mock.calls.length;
    await expect(
      f.payments.returns.request(f.room.id, f.signature),
    ).rejects.toThrow("obligations");
    expect(f.signer.sign).toHaveBeenCalledTimes(count);
  });
  it("holds an uncertain expired return and retries only a finalized failure with identical terms", async () => {
    const f = await manualDeposit();
    await f.payments.returns.request(f.room.id, f.signature);
    const id = `return:${f.signature}`,
      original = f.tx.get(id)!;
    f.hideStatuses(true);
    f.expire();
    await f.payments.tick();
    expect(f.tx.get(id)!.reviewReason).toBe("expired_unconfirmed");
    f.advanceBlock();
    await expect(f.payments.retryFailed(id)).rejects.toThrow(
      "finalized failed",
    );
    expect(f.tx.get(id)!.signature).toBe(original.signature);
    f.hideStatuses(false);
    f.failOnChain();
    await f.payments.recheck(id);
    await f.payments.retryFailed(id);
    expect(f.tx.get(id)!.signature).not.toBe(original.signature);
    expect(transfers(f.tx.get(id)!.transaction).transfers).toEqual(
      transfers(original.transaction).transfers,
    );
  });
});

describe("operator review of an unverified match", () => {
  async function heldMatch() {
    const f = await fixture("1v1", "mainnet");
    await f.fund(0);
    await f.fund(1);
    f.finalize();
    await f.payments.tick();
    f.lock();
    f.ledger.verifying(f.room.id);
    f.ledger.saveRecord({
      info: {
        gameID: f.room.id,
        players: f.room.members.map((m, i) => ({
          clientID: `client-${i}`,
          persistentID: m.id,
        })),
      },
      turns: [],
    } as unknown as PartialGameRecord);
    f.ledger.review(f.room.id, "Verification worker timed out.");
    const enqueue = vi.fn(),
      review = new MatchReview(f.ledger, f.payments, enqueue);
    return {
      ...f,
      enqueue,
      review,
      ops: new Operations(
        f.ledger.db,
        f.payments,
        Date.now,
        undefined,
        undefined,
        review,
      ),
    };
  }
  it("queues the saved recording once, audits the action and refuses a competing refund", async () => {
    const f = await heldMatch();
    expect(f.review.snapshot()[0]).toMatchObject({
      canReplay: true,
      canRefund: true,
    });
    f.ops.reviewMatch(
      f.room.id,
      "replay",
      f.addresses[0],
      "Retry interrupted verification",
    );
    expect(f.ledger.get(f.room.id)!.state).toBe("verifying");
    expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(f.room.id);
    expect(() =>
      f.ops.reviewMatch(
        f.room.id,
        "refund",
        f.addresses[0],
        "Concurrent refund attempt",
      ),
    ).toThrow("recorded result");
    expect(
      f.ledger.db
        .prepare(
          "SELECT action,result FROM operation_audit ORDER BY rowid LIMIT 1",
        )
        .get(),
    ).toMatchObject({ action: "review_replay", result: "queued" });
  });
  it("returns original confirmed entries with zero platform fee after an unrecoverable result", async () => {
    const f = await heldMatch();
    f.ops.reviewMatch(
      f.room.id,
      "refund",
      f.addresses[0],
      "Result cannot be verified after investigation",
    );
    expect(f.ledger.get(f.room.id)).toMatchObject({
      state: "refund_pending",
      feeLamports: 0,
    });
    await f.payments.tick();
    await f.payments.tick();
    expect(f.payments.refundsComplete(f.room.id)).toBe(true);
    for (const player of f.players)
      expect(f.payments.status(f.room.id, player.id).state).toBe("refunded");
    const refunds = f.ledger.db
      .prepare("SELECT body FROM chain_jobs WHERE id LIKE 'refund:%'")
      .all()
      .flatMap(
        (r) => transfers(JSON.parse(String(r.body)).transaction).transfers,
      );
    expect(refunds).toEqual(
      expect.arrayContaining(
        f.players.map((p) => ({ to: p.wallet, lamports: 250_000_000 })),
      ),
    );
    expect(refunds).toHaveLength(2);
    expect(() => f.review.act(f.room.id, "replay")).toThrow();
  });
  it("never replaces a verified winner or an existing payout plan", async () => {
    const f = await heldMatch();
    f.ops.reviewMatch(
      f.room.id,
      "replay",
      f.addresses[0],
      "Retry saved game verification",
    );
    const pool = f.verified();
    await f.payments.settle(pool);
    f.ledger.review(f.room.id, "Payout status needs checking.");
    expect(f.review.snapshot()[0]).toMatchObject({
      canReplay: false,
      canRefund: false,
    });
    const count = f.signer.sign.mock.calls.length;
    expect(() => f.review.act(f.room.id, "refund")).toThrow("recorded result");
    expect(f.signer.sign).toHaveBeenCalledTimes(count);
  });
  it("refuses to resolve a roster whose funds are no longer locked", async () => {
    const f = await heldMatch();
    f.payments.cancel(f.room.id);
    expect(() => f.review.act(f.room.id, "refund")).toThrow("not locked");
    expect(() => f.review.act(f.room.id, "replay")).toThrow("not locked");
  });
});

it("rejects Unranked deposits before any pool wallet, RPC request or signing", async () => {
  const f = await fixture("1v1", "mainnet");
  f.room.ranked = false;
  f.room.stake = "0";
  f.room.lamports = 0;
  await expect(f.payments.prepare(f.room, f.players[0])).rejects.toThrow(
    "Join an open match",
  );
  expect(f.wallets.create).not.toHaveBeenCalled();
  expect(f.wallets.find).not.toHaveBeenCalled();
  expect(f.payments.fundedIDs(f.room.id)).toEqual([]);
});

it("user-owned funding requires its own signature, keeps login identity and freezes refund destinations", async () => {
  const f = await fixture();
  const prep = await f.payments.prepare(
    f.room,
    f.players[0],
    f.addresses[2],
    true,
  );
  expect(prep.fundingSource).toBe("user-wallet");
  expect(prep.fundingAddress).toBe(f.addresses[2]);
  expect(f.signer.sign).not.toHaveBeenCalled();
  await expect(
    f.payments.submit(f.room.id, f.players[0], prep.entryID, prep.transaction),
  ).rejects.toThrow();
  expect(f.sent.size).toBe(0);
  await f.payments.submit(
    f.room.id,
    f.players[0],
    prep.entryID,
    await f.sign(2, prep.transaction!),
  );
  expect(f.sent.size).toBe(1);
  expect(f.signer.sign).not.toHaveBeenCalled();
  expect(
    f.payments.payoutSeats(f.room.id, [
      { ...f.players[0], team: 0, joined: Date.now() },
    ])[0].wallet,
  ).toBe(f.addresses[2]);
  const retry = await f.payments.prepare(
    f.room,
    f.players[0],
    f.addresses[3],
    true,
  );
  expect(retry.fundingAddress).toBe(f.addresses[2]);
});
