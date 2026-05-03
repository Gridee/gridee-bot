import { describe, expect, it } from 'vitest';
import { Ok } from '../../src/client';
import { CommandRegistry } from '../../src/commands';
import { InMemoryIdempotencyStore } from '../../src/dispatcher/InboundIdempotencyStore';
import { MessageDispatcher } from '../../src/dispatcher/MessageDispatcher';
import { FlowRegistry } from '../../src/flows';
import { Phone } from '../../src/lib/phone';
import type { InboundMessage, MessageReceipt, OutboundMessage } from '../../src/messaging';
import { InMemorySessionStore } from '../../src/session/InMemorySessionStore';
import { newSessionState } from '../../src/session/types';
import { DefaultTemplates } from '../../src/templates';
import { FakeBackendClient } from '../flows/harness';

const PHONE: Phone = Phone.of('+2348031234567');

class CapturingSender {
  readonly name = 'capture';
  readonly sent: OutboundMessage[] = [];
  async sendMessage(input: OutboundMessage): Promise<MessageReceipt> {
    this.sent.push(input);
    return {
      to: input.to,
      providerMessageId: `msg_${this.sent.length}`,
      provider: this.name,
      sentAt: 1,
    };
  }
}

function makeInbound(text: string, providerMessageId = 'msg_1'): InboundMessage {
  return {
    from: PHONE,
    text,
    providerMessageId,
    receivedAt: Date.now(),
    provider: 'twilio',
  };
}

function makeRig(opts?: { withCommands?: boolean }): {
  dispatcher: MessageDispatcher;
  sender: CapturingSender;
  sessionStore: InMemorySessionStore;
  client: FakeBackendClient;
} {
  const sessionStore = new InMemorySessionStore({ ttlMs: 60_000 });
  const idempotencyStore = new InMemoryIdempotencyStore();
  const sender = new CapturingSender();
  const client = new FakeBackendClient();
  const flowRegistry = FlowRegistry.default();
  const templates = new DefaultTemplates();

  const deps: ConstructorParameters<typeof MessageDispatcher>[0] = {
    sessionStore,
    idempotencyStore,
    flowRegistry,
    sender,
    client: client as unknown as ConstructorParameters<typeof MessageDispatcher>[0]['client'],
    templates,
    lockTimeoutMs: 1_000,
  };
  if (opts?.withCommands ?? true) {
    deps.commandRegistry = CommandRegistry.default();
  }
  const dispatcher = new MessageDispatcher(deps);
  return { dispatcher, sender, sessionStore, client };
}

// ─── Idle authenticated state — commands fire ────────────────────────────

describe('MessageDispatcher × Commands — idle authenticated', () => {
  it('TENANT_AUTHENTICATED + HELP → tenant help reply', async () => {
    const rig = makeRig();
    await rig.sessionStore.set(PHONE, {
      ...newSessionState({ step: 'TENANT_AUTHENTICATED', role: 'tenant' }),
      jwt: 'jwt',
    });

    await rig.dispatcher.dispatch(makeInbound('HELP'));

    expect(rig.sender.sent).toHaveLength(1);
    expect(rig.sender.sent[0]!.text).toContain('BUY');
    expect(rig.sender.sent[0]!.text).toContain('BALANCE');
    // Session unchanged
    const s = await rig.sessionStore.get(PHONE);
    expect(s!.step).toBe('TENANT_AUTHENTICATED');
  });

  it('LANDLORD_AUTHENTICATED + MY_PROPERTIES → calls backend, formats reply', async () => {
    const rig = makeRig();
    await rig.sessionStore.set(PHONE, {
      ...newSessionState({ step: 'LANDLORD_AUTHENTICATED', role: 'landlord' }),
      jwt: 'jwt',
    });

    // Stub the listProperties call
    (rig.client as unknown as { listProperties: () => unknown }).listProperties = async () =>
      Ok({
        properties: [
          {
            propertyId: 'p1',
            propertyCode: 'GRD-LAG-0042',
            label: 'Surulere Block A',
            address: '12 Adeniran',
            flatCount: 6,
            occupiedCount: 4,
            pendingEarningsGrd: 2.5,
          },
        ],
      });

    await rig.dispatcher.dispatch(makeInbound('MY_PROPERTIES'));

    expect(rig.sender.sent).toHaveLength(1);
    expect(rig.sender.sent[0]!.text).toContain('GRD-LAG-0042');
  });

  it('TENANT_AUTHENTICATED + unknown message → unrecognized command nudge', async () => {
    const rig = makeRig();
    await rig.sessionStore.set(PHONE, {
      ...newSessionState({ step: 'TENANT_AUTHENTICATED', role: 'tenant' }),
      jwt: 'jwt',
    });

    await rig.dispatcher.dispatch(makeInbound('what is this'));

    expect(rig.sender.sent).toHaveLength(1);
    expect(rig.sender.sent[0]!.text).toMatch(/HELP/);
  });
});

// ─── Passthrough — AWAITING_PAYMENT routes to commands ────────────────────

describe('MessageDispatcher × Commands — passthrough from BuyFlow', () => {
  it('AWAITING_PAYMENT + HELP → command runs', async () => {
    const rig = makeRig();
    await rig.sessionStore.set(PHONE, {
      ...newSessionState({ step: 'AWAITING_PAYMENT', role: 'tenant' }),
      jwt: 'jwt',
      data: { paymentId: 'pay_1', txRef: 'TX_1', amountNgn: 5000 },
    });

    await rig.dispatcher.dispatch(makeInbound('HELP'));

    expect(rig.sender.sent).toHaveLength(1);
    expect(rig.sender.sent[0]!.text).toContain('BUY');
  });
});

// ─── Wrong-role command → no match → nudge ───────────────────────────────

describe('MessageDispatcher × Commands — wrong role guard', () => {
  it('tenant typing MY_PROPERTIES → unrecognized', async () => {
    const rig = makeRig();
    await rig.sessionStore.set(PHONE, {
      ...newSessionState({ step: 'TENANT_AUTHENTICATED', role: 'tenant' }),
      jwt: 'jwt',
    });
    await rig.dispatcher.dispatch(makeInbound('MY_PROPERTIES'));
    expect(rig.sender.sent[0]!.text).toMatch(/HELP/);
  });

  it('landlord typing BALANCE → unrecognized', async () => {
    const rig = makeRig();
    await rig.sessionStore.set(PHONE, {
      ...newSessionState({ step: 'LANDLORD_AUTHENTICATED', role: 'landlord' }),
      jwt: 'jwt',
    });
    await rig.dispatcher.dispatch(makeInbound('BALANCE'));
    expect(rig.sender.sent[0]!.text).toMatch(/HELP/);
  });
});

// ─── No command registry → backwards compat ───────────────────────────────

describe('MessageDispatcher × Commands — registry omitted', () => {
  it('falls back to generic nudge when commandRegistry not provided', async () => {
    const rig = makeRig({ withCommands: false });
    await rig.sessionStore.set(PHONE, {
      ...newSessionState({ step: 'TENANT_AUTHENTICATED', role: 'tenant' }),
      jwt: 'jwt',
    });
    await rig.dispatcher.dispatch(makeInbound('HELP'));
    expect(rig.sender.sent).toHaveLength(1);
    // Falls through to errorInvalidInput since no command registry
    expect(rig.sender.sent[0]!.text).toMatch(/didn't understand/i);
  });
});
