import { describe, expect, it } from 'vitest';
import { CommandRegistry, MenuCommand } from '../../src/commands';
import { InMemoryIdempotencyStore } from '../../src/dispatcher/InboundIdempotencyStore';
import { MessageDispatcher } from '../../src/dispatcher/MessageDispatcher';
import { FlowRegistry } from '../../src/flows';
import { Phone } from '../../src/lib/phone';
import type { InboundMessage, MessageReceipt, OutboundMessage } from '../../src/messaging';
import { InMemorySessionStore } from '../../src/session/InMemorySessionStore';
import { newSessionState, type SessionState } from '../../src/session/types';
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

function makeRig(): {
  dispatcher: MessageDispatcher;
  sender: CapturingSender;
  sessionStore: InMemorySessionStore;
  client: FakeBackendClient;
} {
  const sessionStore = new InMemorySessionStore({ ttlMs: 60_000 });
  const idempotencyStore = new InMemoryIdempotencyStore();
  const sender = new CapturingSender();
  const client = new FakeBackendClient();
  const dispatcher = new MessageDispatcher({
    sessionStore,
    idempotencyStore,
    flowRegistry: FlowRegistry.default(),
    commandRegistry: CommandRegistry.default(),
    sender,
    client: client as unknown as ConstructorParameters<typeof MessageDispatcher>[0]['client'],
    templates: new DefaultTemplates(),
    lockTimeoutMs: 1_000,
  });
  return { dispatcher, sender, sessionStore, client };
}

// ─── Unit-level: matches() ────────────────────────────────────────────────

describe('MenuCommand.matches', () => {
  const cmd = new MenuCommand();
  const session: SessionState = newSessionState({ step: 'TENANT_AUTHENTICATED', role: 'tenant' });

  it.each(['MENU', 'menu', ' Menu ', 'HOME', 'home'])('matches "%s"', (input) => {
    expect(cmd.matches(input, session)).toBe(true);
  });

  it.each(['MENUS', 'HOM', 'HELP', 'menu now'])('does not match "%s"', (input) => {
    expect(cmd.matches(input, session)).toBe(false);
  });
});

// ─── Unit-level: handle() returns the right patch per role ────────────────

describe('MenuCommand.handle', () => {
  const cmd = new MenuCommand();
  const templates = new DefaultTemplates();
  const log = {
    fatal: () => undefined, error: () => undefined, warn: () => undefined,
    info: () => undefined, debug: () => undefined, trace: () => undefined,
  } as unknown as Parameters<MenuCommand['handle']>[0]['log'];

  it('tenant role → reply+patch to TENANT_AUTHENTICATED', async () => {
    const session = { ...newSessionState({ step: 'AWAITING_PAYMENT', role: 'tenant' }), jwt: 'jwt' };
    const r = await cmd.handle({
      phone: PHONE, session, client: null as never, templates, log,
    }, 'MENU');
    expect(r.kind).toBe('reply+patch');
    if (r.kind !== 'reply+patch') return;
    expect(r.patch.step).toBe('TENANT_AUTHENTICATED');
    expect(r.patch.clearData).toBe(true);
  });

  it('landlord role → reply+patch to LANDLORD_AUTHENTICATED', async () => {
    const session = { ...newSessionState({ step: 'ADD_PROPERTY_LABEL', role: 'landlord' }), jwt: 'jwt' };
    const r = await cmd.handle({
      phone: PHONE, session, client: null as never, templates, log,
    }, 'HOME');
    expect(r.kind).toBe('reply+patch');
    if (r.kind !== 'reply+patch') return;
    expect(r.patch.step).toBe('LANDLORD_AUTHENTICATED');
  });

  it('null role → reply+patch back to WELCOME_ROLE_SELECT', async () => {
    const session = newSessionState({ step: 'TENANT_REG_OTP' });
    const r = await cmd.handle({
      phone: PHONE, session, client: null as never, templates, log,
    }, 'MENU');
    expect(r.kind).toBe('reply+patch');
    if (r.kind !== 'reply+patch') return;
    expect(r.patch.step).toBe('WELCOME_ROLE_SELECT');
    expect(r.patch.clearData).toBe(true);
  });
});

// ─── Dispatcher integration: works from ANY step including mid-flow ───────

describe('Dispatcher × MENU — bypasses flow dispatch', () => {
  it('AWAITING_PAYMENT + MENU → resets to TENANT_AUTHENTICATED', async () => {
    const rig = makeRig();
    await rig.sessionStore.set(PHONE, {
      ...newSessionState({ step: 'AWAITING_PAYMENT', role: 'tenant' }),
      jwt: 'jwt',
      data: { paymentId: 'pay_1', txRef: 'TX_1', amountNgn: 5000 },
    });

    await rig.dispatcher.dispatch(makeInbound('MENU'));

    const s = await rig.sessionStore.get(PHONE);
    expect(s!.step).toBe('TENANT_AUTHENTICATED');
    expect(s!.data).toEqual({}); // clearData wiped the payment-pending fields
    expect(rig.sender.sent).toHaveLength(1);
    expect(rig.sender.sent[0]!.text).toMatch(/back to/i);
  });

  it('mid-onboarding (TENANT_REG_OTP) + MENU → resets to WELCOME_ROLE_SELECT', async () => {
    const rig = makeRig();
    await rig.sessionStore.set(PHONE, {
      ...newSessionState({ step: 'TENANT_REG_OTP' }),
      data: { fullName: 'Musa', phone: '+2348031234567', otpRef: 'ref_1' },
    });

    await rig.dispatcher.dispatch(makeInbound('MENU'));

    const s = await rig.sessionStore.get(PHONE);
    expect(s!.step).toBe('WELCOME_ROLE_SELECT');
    expect(s!.data).toEqual({});
  });

  it('TENANT_AUTHENTICATED + MENU → no-op stay (still TENANT_AUTHENTICATED)', async () => {
    const rig = makeRig();
    await rig.sessionStore.set(PHONE, {
      ...newSessionState({ step: 'TENANT_AUTHENTICATED', role: 'tenant' }),
      jwt: 'jwt',
    });

    await rig.dispatcher.dispatch(makeInbound('MENU'));

    const s = await rig.sessionStore.get(PHONE);
    expect(s!.step).toBe('TENANT_AUTHENTICATED');
    expect(s!.role).toBe('tenant');
    expect(s!.jwt).toBe('jwt'); // auth preserved
  });

  it('mid-buy (BUY_CONFIRM) + HOME → resets to TENANT_AUTHENTICATED', async () => {
    const rig = makeRig();
    await rig.sessionStore.set(PHONE, {
      ...newSessionState({ step: 'BUY_CONFIRM', role: 'tenant' }),
      jwt: 'jwt',
      data: { amountNgn: 5000 },
    });

    await rig.dispatcher.dispatch(makeInbound('HOME'));

    const s = await rig.sessionStore.get(PHONE);
    expect(s!.step).toBe('TENANT_AUTHENTICATED');
    expect(s!.data).toEqual({});
  });

  it('preserves auth across MENU (jwt + userId + role unchanged)', async () => {
    const rig = makeRig();
    await rig.sessionStore.set(PHONE, {
      ...newSessionState({ step: 'AWAITING_PAYMENT', role: 'tenant' }),
      jwt: 'the-jwt',
      userId: 'usr_1',
      data: { something: 'partial' },
    });

    await rig.dispatcher.dispatch(makeInbound('MENU'));

    const s = await rig.sessionStore.get(PHONE);
    expect(s!.jwt).toBe('the-jwt');
    expect(s!.userId).toBe('usr_1');
    expect(s!.role).toBe('tenant');
  });

  it('after MENU, BUY shortcut works (proves AWAITING_PAYMENT loose end is tied)', async () => {
    const rig = makeRig();
    await rig.sessionStore.set(PHONE, {
      ...newSessionState({ step: 'AWAITING_PAYMENT', role: 'tenant' }),
      jwt: 'jwt',
    });

    // MENU resets
    await rig.dispatcher.dispatch(makeInbound('MENU', 'm_1'));
    let s = await rig.sessionStore.get(PHONE);
    expect(s!.step).toBe('TENANT_AUTHENTICATED');

    // Now BUY 5000 should fire the shortcut
    await rig.dispatcher.dispatch(makeInbound('BUY 5000', 'm_2'));
    s = await rig.sessionStore.get(PHONE);
    expect(s!.step).toBe('BUY_CONFIRM');
    expect(s!.data['amountNgn']).toBe(5000);
  });
});
