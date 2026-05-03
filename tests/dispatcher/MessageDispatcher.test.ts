import { describe, expect, it, vi } from 'vitest';
import { Ok } from '../../src/client';
import { InMemoryIdempotencyStore } from '../../src/dispatcher/InboundIdempotencyStore';
import { MessageDispatcher } from '../../src/dispatcher/MessageDispatcher';
import { FlowRegistry, type FlowContext, type FlowResult, type IFlow } from '../../src/flows';
import { Phone } from '../../src/lib/phone';
import type { InboundMessage, MessageReceipt, OutboundMessage } from '../../src/messaging';
import { InMemorySessionStore } from '../../src/session/InMemorySessionStore';
import type { ISessionStore } from '../../src/session/ISessionStore';
import { newSessionState, type SessionStep } from '../../src/session/types';
import { DefaultTemplates } from '../../src/templates';
import { FakeBackendClient } from '../flows/harness';

// ─────────────────────────────────────────────────────────────────────────────
// Lightweight test rig
// ─────────────────────────────────────────────────────────────────────────────

class CapturingSender {
  readonly name = 'capture';
  readonly sent: OutboundMessage[] = [];
  shouldFail = false;
  async sendMessage(input: OutboundMessage): Promise<MessageReceipt> {
    if (this.shouldFail) throw new Error('send blew up');
    this.sent.push(input);
    return {
      to: input.to,
      providerMessageId: `msg_${this.sent.length}`,
      provider: this.name,
      sentAt: Date.now(),
    };
  }
}

const PHONE: Phone = Phone.of('+2348031234567');

function makeInbound(text: string, providerMessageId = 'msg_1'): InboundMessage {
  return {
    from: PHONE,
    text,
    providerMessageId,
    receivedAt: Date.now(),
    provider: 'twilio',
  };
}

interface Rig {
  dispatcher: MessageDispatcher;
  sender: CapturingSender;
  sessionStore: ISessionStore;
  client: FakeBackendClient;
  idempotencyStore: InMemoryIdempotencyStore;
}

function makeRig(opts?: { flows?: ReadonlyArray<IFlow> }): Rig {
  const sessionStore = new InMemorySessionStore({ ttlMs: 60_000 });
  const idempotencyStore = new InMemoryIdempotencyStore();
  const sender = new CapturingSender();
  const client = new FakeBackendClient();
  const flowRegistry = opts?.flows ? new FlowRegistry(opts.flows) : FlowRegistry.default();
  const templates = new DefaultTemplates();

  const dispatcher = new MessageDispatcher({
    sessionStore,
    idempotencyStore,
    flowRegistry,
    sender,
    client: client as unknown as ConstructorParameters<typeof MessageDispatcher>[0]['client'],
    templates,
    lockTimeoutMs: 1_000, // short for tests
  });

  return { dispatcher, sender, sessionStore, client, idempotencyStore };
}

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency
// ─────────────────────────────────────────────────────────────────────────────

describe('MessageDispatcher — idempotency', () => {
  it('processes a first inbound and skips its duplicate', async () => {
    const rig = makeRig();
    const inbound = makeInbound('1', 'dup-msg-id');

    const r1 = await rig.dispatcher.dispatch(inbound);
    expect(r1.kind).toBe('handled');
    expect(rig.sender.sent.length).toBe(1);

    const r2 = await rig.dispatcher.dispatch(inbound);
    expect(r2.kind).toBe('duplicate');
    expect(rig.sender.sent.length).toBe(1); // no second send
  });

  it('still processes if idempotency store throws (defensive)', async () => {
    const rig = makeRig();
    vi.spyOn(rig.idempotencyStore, 'markProcessed').mockRejectedValueOnce(new Error('redis down'));
    const r = await rig.dispatcher.dispatch(makeInbound('1'));
    expect(r.kind).toBe('handled');
    expect(rig.sender.sent.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// New phone — initialize session
// ─────────────────────────────────────────────────────────────────────────────

describe('MessageDispatcher — new phone initialization', () => {
  it('initializes a new session at WELCOME_ROLE_SELECT', async () => {
    const rig = makeRig();
    await rig.dispatcher.dispatch(makeInbound('hi'));
    const session = await rig.sessionStore.get(PHONE);
    expect(session).not.toBeNull();
    // 'hi' wasn't a valid role → flow stays at WELCOME_ROLE_SELECT and re-prompts.
    expect(session!.step).toBe('WELCOME_ROLE_SELECT');
    // The reply was sent
    expect(rig.sender.sent.length).toBe(1);
    expect(rig.sender.sent[0]!.text).toContain('Landlord');
  });

  it('advances after valid role pick', async () => {
    const rig = makeRig();
    await rig.dispatcher.dispatch(makeInbound('1'));
    const session = await rig.sessionStore.get(PHONE);
    expect(session!.step).toBe('LANDLORD_REG_NAME');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Send-first / save-second ordering
// ─────────────────────────────────────────────────────────────────────────────

describe('MessageDispatcher — send/save ordering', () => {
  it('does NOT advance session when send fails', async () => {
    const rig = makeRig();
    rig.sender.shouldFail = true;

    await rig.dispatcher.dispatch(makeInbound('1'));

    // No session was saved — first send failed before save
    const session = await rig.sessionStore.get(PHONE);
    expect(session).toBeNull();
  });

  it('on send failure during stay, no patch applied', async () => {
    const rig = makeRig();
    // First successful interaction: advance to LANDLORD_REG_NAME
    await rig.dispatcher.dispatch(makeInbound('1', 'msg_a'));
    expect((await rig.sessionStore.get(PHONE))!.step).toBe('LANDLORD_REG_NAME');

    // Now break the sender; send a name that would advance — should not.
    rig.sender.shouldFail = true;
    await rig.dispatcher.dispatch(makeInbound('Adeola Bayo', 'msg_b'));

    const session = await rig.sessionStore.get(PHONE);
    expect(session!.step).toBe('LANDLORD_REG_NAME'); // unchanged
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FlowResult kinds — exhaustive
// ─────────────────────────────────────────────────────────────────────────────

class StubFlow implements IFlow {
  readonly id = 'STUB';
  constructor(
    private readonly steps: ReadonlySet<SessionStep>,
    private readonly result: () => Promise<FlowResult> | FlowResult,
  ) {}
  handles(step: SessionStep): boolean {
    return this.steps.has(step);
  }
  async handle(_ctx: FlowContext, _msg: string): Promise<FlowResult> {
    return await this.result();
  }
}

describe('MessageDispatcher — FlowResult kinds', () => {
  function rigWithStub(result: () => FlowResult): {
    rig: Rig;
    seedSession: () => Promise<void>;
  } {
    const flow = new StubFlow(new Set(['LANDLORD_REG_NAME']), result);
    const rig = makeRig({ flows: [flow] });
    return {
      rig,
      seedSession: async () => {
        await rig.sessionStore.set(PHONE, {
          ...newSessionState({ step: 'LANDLORD_REG_NAME' }),
        });
      },
    };
  }

  it('handles "advance" — sends reply, applies patch', async () => {
    const { rig, seedSession } = rigWithStub(() => ({
      kind: 'advance',
      reply: 'next!',
      patch: { step: 'LANDLORD_REG_PHONE', data: { fullName: 'X' } },
    }));
    await seedSession();
    await rig.dispatcher.dispatch(makeInbound('whatever'));

    expect(rig.sender.sent[0]!.text).toBe('next!');
    const s = await rig.sessionStore.get(PHONE);
    expect(s!.step).toBe('LANDLORD_REG_PHONE');
    expect(s!.data['fullName']).toBe('X');
  });

  it('handles "complete" — sends reply, applies terminal patch', async () => {
    const { rig, seedSession } = rigWithStub(() => ({
      kind: 'complete',
      reply: 'done!',
      patch: { step: 'LANDLORD_AUTHENTICATED', clearData: true },
    }));
    await seedSession();
    await rig.dispatcher.dispatch(makeInbound('whatever'));

    expect(rig.sender.sent[0]!.text).toBe('done!');
    const s = await rig.sessionStore.get(PHONE);
    expect(s!.step).toBe('LANDLORD_AUTHENTICATED');
    expect(s!.data).toEqual({});
  });

  it('handles "stay" with patch — sends reply, applies partial patch', async () => {
    const { rig, seedSession } = rigWithStub(() => ({
      kind: 'stay',
      reply: 'try again',
      patch: { data: { otpAttempts: 1 } },
    }));
    await seedSession();
    await rig.dispatcher.dispatch(makeInbound('whatever'));

    expect(rig.sender.sent[0]!.text).toBe('try again');
    const s = await rig.sessionStore.get(PHONE);
    expect(s!.step).toBe('LANDLORD_REG_NAME');
    expect(s!.data['otpAttempts']).toBe(1);
  });

  it('handles "stay" without patch — sends reply, leaves session alone', async () => {
    const { rig, seedSession } = rigWithStub(() => ({ kind: 'stay', reply: 'nope' }));
    await seedSession();
    await rig.dispatcher.dispatch(makeInbound('whatever'));

    expect(rig.sender.sent[0]!.text).toBe('nope');
    const s = await rig.sessionStore.get(PHONE);
    expect(s!.step).toBe('LANDLORD_REG_NAME');
  });

  it('handles "reset" — sends reply, clears session', async () => {
    const { rig, seedSession } = rigWithStub(() => ({ kind: 'reset', reply: 'starting over' }));
    await seedSession();
    await rig.dispatcher.dispatch(makeInbound('whatever'));

    expect(rig.sender.sent[0]!.text).toBe('starting over');
    const s = await rig.sessionStore.get(PHONE);
    expect(s).toBeNull();
  });

  it('handles "reset" even if send fails — clears session anyway', async () => {
    const { rig, seedSession } = rigWithStub(() => ({ kind: 'reset', reply: 'starting over' }));
    await seedSession();
    rig.sender.shouldFail = true;
    await rig.dispatcher.dispatch(makeInbound('whatever'));
    const s = await rig.sessionStore.get(PHONE);
    expect(s).toBeNull(); // still cleared so user can recover
  });

  it('handles "passthrough" — sends nudge, does not change session', async () => {
    const { rig, seedSession } = rigWithStub(() => ({ kind: 'passthrough' }));
    await seedSession();
    await rig.dispatcher.dispatch(makeInbound('whatever'));

    expect(rig.sender.sent.length).toBe(1);
    const s = await rig.sessionStore.get(PHONE);
    expect(s!.step).toBe('LANDLORD_REG_NAME'); // unchanged
  });

  it('catches a flow that throws — sends generic error, does not crash', async () => {
    const { rig, seedSession } = rigWithStub(() => {
      throw new Error('flow bug');
    });
    await seedSession();
    const result = await rig.dispatcher.dispatch(makeInbound('whatever'));
    expect(result.kind).toBe('handled'); // dispatcher recovered
    expect(rig.sender.sent.length).toBe(1);
    const s = await rig.sessionStore.get(PHONE);
    expect(s!.step).toBe('LANDLORD_REG_NAME'); // unchanged
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Concurrent inbound — same phone serialized
// ─────────────────────────────────────────────────────────────────────────────

describe('MessageDispatcher — concurrency', () => {
  it('serializes concurrent webhooks for same phone', async () => {
    const rig = makeRig();
    const calls = await Promise.all([
      rig.dispatcher.dispatch(makeInbound('1', 'msg_a')),
      rig.dispatcher.dispatch(makeInbound('1', 'msg_b')),
    ]);
    expect(calls.every((c) => c.kind === 'handled')).toBe(true);
    expect(rig.sender.sent.length).toBe(2);
    // Both should have advanced the session (second one would re-advance from
    // the now-LANDLORD_REG_NAME step → that step's flow handles it). The
    // important property is that they don't trample each other.
    const s = await rig.sessionStore.get(PHONE);
    expect(s).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BUY shortcut interception
// ─────────────────────────────────────────────────────────────────────────────

describe('MessageDispatcher — BUY shortcut', () => {
  it('"BUY 5000" from authenticated tenant skips to BUY_CONFIRM', async () => {
    const rig = makeRig();
    await rig.sessionStore.set(PHONE, {
      ...newSessionState({ step: 'TENANT_AUTHENTICATED', role: 'tenant' }),
      jwt: 'jwt',
    });

    await rig.dispatcher.dispatch(makeInbound('BUY 5000', 'msg_buy'));

    const session = await rig.sessionStore.get(PHONE);
    // The shortcut puts us at BUY_CONFIRM with the amount pre-seeded; the
    // BuyFlow then receives the same message ("BUY 5000") which doesn't
    // parse as a payment method (1/2), so it returns 'stay' on BUY_CONFIRM.
    expect(session!.step).toBe('BUY_CONFIRM');
    expect(session!.data['amountNgn']).toBe(5000);
  });

  it('"BUY 5000" full happy path requires two messages: shortcut then method', async () => {
    const rig = makeRig();
    await rig.sessionStore.set(PHONE, {
      ...newSessionState({ step: 'TENANT_AUTHENTICATED', role: 'tenant' }),
      jwt: 'jwt',
    });

    // Step 1: "BUY 5000" — intercepts to BUY_CONFIRM, then BuyFlow runs with
    // the same message. Since "BUY 5000" doesn't parse as a payment method,
    // BuyFlow returns 'stay' at BUY_CONFIRM.
    await rig.dispatcher.dispatch(makeInbound('BUY 5000', 'msg_1'));
    let s = await rig.sessionStore.get(PHONE);
    expect(s!.step).toBe('BUY_CONFIRM');
    expect(s!.data['amountNgn']).toBe(5000);

    // Step 2: "1" — picks bank transfer, advances to AWAITING_PAYMENT
    await rig.dispatcher.dispatch(makeInbound('1', 'msg_2'));
    s = await rig.sessionStore.get(PHONE);
    expect(s!.step).toBe('AWAITING_PAYMENT');
  });

  it('"BUY" alone from authenticated tenant routes to BUY_AMOUNT', async () => {
    const rig = makeRig();
    await rig.sessionStore.set(PHONE, {
      ...newSessionState({ step: 'TENANT_AUTHENTICATED', role: 'tenant' }),
      jwt: 'jwt',
    });

    await rig.dispatcher.dispatch(makeInbound('BUY'));
    const s = await rig.sessionStore.get(PHONE);
    expect(s!.step).toBe('BUY_AMOUNT');
  });

  it('"BUY 5000" from non-authenticated tenant is NOT intercepted', async () => {
    const rig = makeRig();
    // Non-authenticated tenant — should not match the shortcut
    await rig.sessionStore.set(PHONE, {
      ...newSessionState({ step: 'WELCOME_ROLE_SELECT' }),
    });

    await rig.dispatcher.dispatch(makeInbound('BUY 5000'));
    const s = await rig.sessionStore.get(PHONE);
    // Stayed at WELCOME — message was treated as a (failed) role pick
    expect(s!.step).toBe('WELCOME_ROLE_SELECT');
  });

  it('"BUY abc" with garbage amount routes to BUY_AMOUNT prompt', async () => {
    const rig = makeRig();
    await rig.sessionStore.set(PHONE, {
      ...newSessionState({ step: 'TENANT_AUTHENTICATED', role: 'tenant' }),
      jwt: 'jwt',
    });

    await rig.dispatcher.dispatch(makeInbound('BUY abc'));
    const s = await rig.sessionStore.get(PHONE);
    expect(s!.step).toBe('BUY_AMOUNT');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// No flow handles step (idle authenticated)
// ─────────────────────────────────────────────────────────────────────────────

describe('MessageDispatcher — no flow', () => {
  it('TENANT_AUTHENTICATED + non-BUY message → nudge', async () => {
    const rig = makeRig();
    await rig.sessionStore.set(PHONE, {
      ...newSessionState({ step: 'TENANT_AUTHENTICATED', role: 'tenant' }),
      jwt: 'jwt',
    });

    await rig.dispatcher.dispatch(makeInbound('hello'));
    expect(rig.sender.sent.length).toBe(1); // nudge
    const s = await rig.sessionStore.get(PHONE);
    expect(s!.step).toBe('TENANT_AUTHENTICATED'); // unchanged
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end happy path through real flows
// ─────────────────────────────────────────────────────────────────────────────

describe('MessageDispatcher — landlord onboarding end-to-end', () => {
  it('walks the full chained flow: WELCOME → LANDLORD_AUTHENTICATED', async () => {
    const rig = makeRig();
    // Override the verifyOtp result so we get a landlord JWT back
    rig.client.verifyOtpResult = Ok({
      jwt: 'jwt.landlord.token',
      userId: 'usr_1',
      role: 'landlord',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const messages: ReadonlyArray<readonly [string, SessionStep]> = [
      ['1', 'LANDLORD_REG_NAME'],
      ['Adeola Bayo', 'LANDLORD_REG_PHONE'],
      ['+2348031234567', 'LANDLORD_REG_OTP'],
      ['123456', 'ADD_PROPERTY_ADDRESS'],
      ['12 Adeniran St, Surulere, Lagos', 'ADD_PROPERTY_FLAT_COUNT'],
      ['6', 'ADD_PROPERTY_LABEL'],
      ['Surulere Block A', 'LANDLORD_AUTHENTICATED'],
    ];

    for (let i = 0; i < messages.length; i++) {
      const [msg, expectedStepAfter] = messages[i]!;
      await rig.dispatcher.dispatch(makeInbound(msg, `msg_${i}`));
      const s = await rig.sessionStore.get(PHONE);
      expect(s!.step).toBe(expectedStepAfter);
    }

    expect(rig.sender.sent.length).toBe(messages.length);
    expect(rig.client.calls.registerLandlord.length).toBe(1);
    expect(rig.client.calls.verifyOtp.length).toBe(1);
    expect(rig.client.calls.addProperty.length).toBe(1);

    // Final session has JWT and is at LANDLORD_AUTHENTICATED
    const final = await rig.sessionStore.get(PHONE);
    expect(final!.jwt).toBe('jwt.landlord.token');
    expect(final!.role).toBe('landlord');
  });
});
