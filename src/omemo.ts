import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomInt, randomUUID, timingSafeEqual, webcrypto } from "node:crypto";

import { xml, type XmppClient, type XmppElement } from "@xmpp/client";
import parseXml from "@xmpp/xml/lib/parse.js";
import {
  Direction as SignalDirection,
  KeyHelper,
  SessionBuilder,
  SessionCipher,
  SignalProtocolAddress,
  setWebCrypto,
  type DeviceType,
  type KeyPairType,
  type StorageType,
} from "@privacyresearch/libsignal-protocol-typescript";

import { normalizeXmppBareJid } from "./ids.js";
import type { ResolvedXmppAccount } from "./channel.js";

setWebCrypto(webcrypto as unknown as Crypto);

export type XmppOmemoMode = "off" | "optional" | "required";

export interface ResolvedXmppOmemoConfig {
  mode: XmppOmemoMode;
  allowUnencryptedFallback: boolean;
  replyOnUnsupportedInbound: boolean;
  statePath?: string;
}

export interface XmppOmemoEncryptedReceiveResult {
  handled: boolean;
  body?: string;
}

export interface XmppOmemoController {
  readonly config: ResolvedXmppOmemoConfig;
  readonly statePath: string;
  initialize(): Promise<void>;
  beforeSend(params: {
    to: string;
    chatType: "direct" | "channel";
    text: string;
    messageId: string;
  }): Promise<XmppElement | null>;
  afterPlaintextSend(params: {
    to: string;
    chatType: "direct" | "channel";
    text: string;
  }): Promise<void>;
  handleInboundEncryptedDm(params: {
    from: string;
    stanza: XmppElement;
    reply?: (text: string) => Promise<void>;
  }): Promise<XmppOmemoEncryptedReceiveResult>;
  allowInboundPlaintextDm(params: {
    from: string;
    body: string;
    reply?: (text: string) => Promise<void>;
  }): Promise<boolean>;
  stop(): Promise<void>;
}

interface XmppOmemoLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
  debug?: (message: string) => void;
}

interface XmppOmemoStatusSink {
  (status: Record<string, unknown>): void;
}

interface XmppOmemoState {
  version: 2;
  accountId: string;
  accountJid: string;
  createdAt: string;
  updatedAt: string;
  interoperability: {
    cryptoImplemented: true;
    bundlePublishingImplemented: true;
    lastWarning?: string;
    lastSuccessfulEncryptionAt?: string;
    lastSuccessfulDecryptionAt?: string;
  };
  signal: XmppOmemoSignalState;
  contacts: Record<string, XmppOmemoContactState>;
}

interface XmppOmemoSignalState {
  deviceId: number;
  registrationId: number;
  nextSignedPreKeyId: number;
  nextPreKeyId: number;
  identityKeyPair: SerializedKeyPair;
  signedPreKeys: Record<string, SerializedSignedPreKey>;
  activeSignedPreKeyId: number;
  preKeys: Record<string, SerializedKeyPair>;
  sessions: Record<string, string>;
  identities: Record<string, SerializedIdentityRecord>;
  lastBundlePublishedAt?: string;
}

interface XmppOmemoContactState {
  bareJid: string;
  lastPlaintextInboundAt?: string;
  lastPlaintextOutboundAt?: string;
  lastEncryptedInboundAt?: string;
  lastEncryptedOutboundAt?: string;
  lastEncryptedInbound?: XmppOmemoEncryptedInboundSnapshot;
  deviceList?: XmppOmemoDeviceListSnapshot;
  devices?: Record<string, XmppOmemoDeviceSnapshot>;
  policyViolations?: XmppOmemoPolicyViolation[];
}

interface XmppOmemoDeviceSnapshot {
  deviceId: number;
  fingerprint?: string;
  bundle?: XmppOmemoBundleSnapshot;
}

interface XmppOmemoEncryptedInboundSnapshot {
  sid?: number;
  recipientDeviceIds: number[];
  payloadBytes: number;
  isPreKeyMessage: boolean;
  decrypted: boolean;
}

interface XmppOmemoDeviceListSnapshot {
  fetchedAt: string;
  deviceIds: number[];
  fetchError?: string;
}

interface XmppOmemoBundleSnapshot {
  fetchedAt: string;
  signedPreKeyId: number;
  preKeyIds: number[];
  fingerprint: string;
  fetchError?: string;
}

interface XmppOmemoPolicyViolation {
  at: string;
  direction: "inbound" | "outbound";
  reason: string;
}

interface XmppOmemoDeviceListResult {
  deviceIds: number[];
  fetchedAt: string;
  fetchError?: string;
}

interface XmppOmemoBundleResult {
  fetchedAt: string;
  bundle?: DeviceType<ArrayBuffer>;
  fingerprint?: string;
  signedPreKeyId?: number;
  preKeyIds?: number[];
  fetchError?: string;
}

interface SerializedKeyPair {
  pubKey: string;
  privKey: string;
}

interface SerializedSignedPreKey extends SerializedKeyPair {
  keyId: number;
  signature: string;
  createdAt: string;
}

interface SerializedIdentityRecord {
  publicKey: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

interface CreateXmppOmemoControllerParams {
  account: ResolvedXmppAccount;
  client: XmppClient;
  log?: XmppOmemoLogger;
  setStatus?: XmppOmemoStatusSink;
}

interface XmppOmemoPayloadMaterial {
  key: ArrayBuffer;
  tag: ArrayBuffer;
  keyAndTag: ArrayBuffer;
  payload: string;
}

interface XmppOmemoDecryptedHeader {
  key: ArrayBuffer;
  tag: ArrayBuffer;
  sid: number;
  isPreKey: boolean;
}

export const NS_OMEMO = "urn:xmpp:omemo:2";
const NS_PUBSUB = "http://jabber.org/protocol/pubsub";
const NS_HINTS = "urn:xmpp:hints";
const NS_EME = "urn:xmpp:eme:0";
export const OMEMO_DEVICELIST_NODE = "urn:xmpp:omemo:2:devices";
export const OMEMO_BUNDLES_NODE = "urn:xmpp:omemo:2:bundles";
const NS_SCE = "urn:xmpp:sce:1";
const NS_JABBER_CLIENT = "jabber:client";
const DEVICE_LIST_CACHE_TTL_MS = 10 * 60_000;
const BUNDLE_CACHE_TTL_MS = 10 * 60_000;
const MAX_POLICY_VIOLATIONS = 16;
const PREKEY_LOW_WATERMARK = 25;
const PREKEY_TARGET_COUNT = 100;
const AES_PAYLOAD_KEY_LENGTH = 256;
const PAYLOAD_KEY_BYTES = 32;
const PAYLOAD_HMAC_BYTES = 16;
const HKDF_BYTES = 80;
const HKDF_INFO_PAYLOAD = "OMEMO Payload";
const TAG_BYTES = 16;

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "default";
}

function nowIso(): string {
  return new Date().toISOString();
}

function resolveStatePath(account: ResolvedXmppAccount): string {
  const configured = account.omemo.statePath?.trim();
  if (configured) {
    return path.resolve(process.cwd(), configured);
  }

  const accountPart = sanitizePathSegment(account.accountId || "default");
  return path.resolve(process.cwd(), ".openclaw", "xmpp", "omemo", `${accountPart}.json`);
}

function normalizeContactJid(raw: string): string {
  const normalized = normalizeXmppBareJid(raw);
  if (!normalized) {
    throw new Error(`Invalid XMPP JID for OMEMO state: ${raw}`);
  }
  return normalized;
}

function parseNumericAttr(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function uniqueSortedNumbers(values: number[]): number[] {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value > 0))].sort(
    (a, b) => a - b
  );
}

function elementChildren(
  element: XmppElement | null | undefined,
  name: string,
  xmlns?: string
): XmppElement[] {
  if (!element) return [];
  if (element.getChildren) {
    return element.getChildren(name, xmlns) ?? [];
  }
  return (
    element
      .getChildElements?.()
      ?.filter((child) => child.is(name, xmlns) || child.is(name)) ?? []
  );
}

function asArrayBuffer(input: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (input instanceof Uint8Array) {
    return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer;
  }
  return input;
}

function concatArrayBuffers(...parts: ArrayBuffer[]): ArrayBuffer {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(new Uint8Array(part), offset);
    offset += part.byteLength;
  }
  return out.buffer;
}

function base64FromArrayBuffer(input: ArrayBuffer): string {
  return Buffer.from(new Uint8Array(input)).toString("base64");
}

function arrayBufferFromBase64(input: string): ArrayBuffer {
  const buffer = Buffer.from(input, "base64");
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

function binaryStringFromArrayBuffer(input: ArrayBuffer): string {
  return Buffer.from(new Uint8Array(input)).toString("binary");
}

function arrayBufferFromBinaryString(input: string): ArrayBuffer {
  const buffer = Buffer.from(input, "binary");
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

function utf8ArrayBuffer(input: string): ArrayBuffer {
  return new TextEncoder().encode(input).buffer;
}

function utf8FromArrayBuffer(input: ArrayBuffer): string {
  return new TextDecoder().decode(new Uint8Array(input));
}

function randomBytes(size: number): ArrayBuffer {
  const bytes = new Uint8Array(size);
  webcrypto.getRandomValues(bytes);
  return bytes.buffer;
}

async function hkdfSha256(input: ArrayBuffer, info: string, bytes: number): Promise<ArrayBuffer> {
  const key = await webcrypto.subtle.importKey("raw", input, "HKDF", false, ["deriveBits"]);
  const bits = await webcrypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: new TextEncoder().encode(info),
    },
    key,
    bytes * 8
  );
  return bits;
}

async function hmacSha256(key: ArrayBuffer, data: ArrayBuffer): Promise<ArrayBuffer> {
  const keyObject = await webcrypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
  return await webcrypto.subtle.sign("HMAC", keyObject, data);
}

function truncateArrayBuffer(input: ArrayBuffer, bytes: number): ArrayBuffer {
  return input.slice(0, bytes);
}

function randomPaddingBase64(targetBytes = 32): string {
  return base64FromArrayBuffer(randomBytes(targetBytes));
}

export function buildOmemoSceEnvelope(text: string, from: string): XmppElement {
  return xml(
    "envelope",
    { xmlns: NS_SCE },
    xml("content", {}, xml("body", { xmlns: NS_JABBER_CLIENT }, text)),
    xml("rpad", {}, randomPaddingBase64()),
    xml("from", { jid: from })
  );
}

export function extractBodyFromSceEnvelopeString(input: string): string | null {
  try {
    const envelope = parseXml(input);
    const content = envelope?.getChild("content", NS_SCE) ?? envelope?.getChild("content");
    const body =
      content?.getChild("body", NS_JABBER_CLIENT) ??
      content?.getChild("body") ??
      envelope?.getChild("body", NS_JABBER_CLIENT) ??
      envelope?.getChild("body");
    const text = body?.text?.()?.trim();
    return text || null;
  } catch {
    const match = input.match(/<body(?:\s[^>]*)?>([\s\S]*?)<\/body>/i);
    return match?.[1]?.trim() || null;
  }
}

function isXmppItemNotFoundError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return message.includes("item-not-found");
}

function buildPubsubPublishOptions(fields: Record<string, string>): XmppElement {
  return xml(
    "publish-options",
    {},
    xml(
      "x",
      { xmlns: "jabber:x:data", type: "submit" },
      xml(
        "field",
        { var: "FORM_TYPE", type: "hidden" },
        xml("value", {}, "http://jabber.org/protocol/pubsub#publish-options")
      ),
      ...Object.entries(fields).map(([name, value]) =>
        xml("field", { var: name }, xml("value", {}, value))
      )
    )
  );
}

export function buildOmemoDeviceListItem(deviceIds: number[]): XmppElement {
  return xml(
    "item",
    { id: "current" },
    xml(
      "devices",
      { xmlns: NS_OMEMO },
      ...deviceIds.map((deviceId) => xml("device", { id: String(deviceId) }))
    )
  );
}

export function buildOmemoBundleItem(
  deviceId: number,
  activeSignedPreKey: SerializedSignedPreKey,
  preKeyEntries: Array<{ keyId: number; pair: SerializedKeyPair }>,
  identityKey: SerializedKeyPair
): XmppElement {
  return xml(
    "item",
    { id: String(deviceId) },
    xml(
      "bundle",
      { xmlns: NS_OMEMO },
      xml("spk", { id: String(activeSignedPreKey.keyId) }, activeSignedPreKey.pubKey),
      xml("spks", {}, activeSignedPreKey.signature),
      xml("ik", {}, identityKey.pubKey),
      xml(
        "prekeys",
        {},
        ...preKeyEntries.map(({ keyId, pair }) => xml("pk", { id: String(keyId) }, pair.pubKey))
      )
    )
  );
}

function buildOmemoKeysElement(jid: string, keyElements: XmppElement[]): XmppElement {
  return xml("keys", { jid }, ...keyElements);
}

function findChildByName(element: XmppElement | null | undefined, names: string[], xmlns?: string): XmppElement | null {
  for (const name of names) {
    const child = element?.getChild(name, xmlns) ?? element?.getChild(name);
    if (child) return child;
  }
  return null;
}

function generateOmemoDeviceId(): number {
  return randomInt(1, 0x7fffffff);
}

function parseEncodedAddress(value: string): { name: string; deviceId: number } | null {
  const lastDot = value.lastIndexOf(".");
  if (lastDot <= 0) return null;
  const name = value.slice(0, lastDot);
  const deviceId = Number.parseInt(value.slice(lastDot + 1), 10);
  if (!name || !Number.isInteger(deviceId)) return null;
  return { name, deviceId };
}

function bufferFingerprint(input: ArrayBuffer): string {
  return createHash("sha256").update(Buffer.from(new Uint8Array(input))).digest("hex");
}

function serializeKeyPair(pair: KeyPairType<ArrayBuffer>): SerializedKeyPair {
  return {
    pubKey: base64FromArrayBuffer(pair.pubKey),
    privKey: base64FromArrayBuffer(pair.privKey),
  };
}

function deserializeKeyPair(pair: SerializedKeyPair | undefined): KeyPairType<ArrayBuffer> | undefined {
  if (!pair?.pubKey || !pair?.privKey) return undefined;
  return {
    pubKey: arrayBufferFromBase64(pair.pubKey),
    privKey: arrayBufferFromBase64(pair.privKey),
  };
}

function createEmptyState(account: ResolvedXmppAccount): XmppOmemoState {
  const timestamp = nowIso();
  const registrationId = KeyHelper.generateRegistrationId();
  const deviceId = generateOmemoDeviceId();
  const placeholder = serializeKeyPair({ pubKey: new ArrayBuffer(0), privKey: new ArrayBuffer(0) });
  return {
    version: 2,
    accountId: account.accountId,
    accountJid: account.jid,
    createdAt: timestamp,
    updatedAt: timestamp,
    interoperability: {
      cryptoImplemented: true,
      bundlePublishingImplemented: true,
    },
    signal: {
      deviceId,
      registrationId,
      nextSignedPreKeyId: 2,
      nextPreKeyId: 1,
      identityKeyPair: placeholder,
      signedPreKeys: {},
      activeSignedPreKeyId: 1,
      preKeys: {},
      sessions: {},
      identities: {},
    },
    contacts: {},
  };
}

function extractOmemoEncryptedSnapshot(stanza: XmppElement): XmppOmemoEncryptedInboundSnapshot | null {
  const encrypted = stanza.getChild("encrypted", NS_OMEMO);
  if (!encrypted) return null;

  const header = encrypted.getChild("header", NS_OMEMO) ?? encrypted.getChild("header");
  const recipientDeviceIds = uniqueSortedNumbers(
    elementChildren(header, "keys")
      .flatMap((keys) => elementChildren(keys, "key"))
      .map((key) => parseNumericAttr(key.attrs.rid))
      .filter((value): value is number => value !== undefined)
  );
  const payload = encrypted.getChildText("payload", NS_OMEMO) ?? encrypted.getChildText("payload") ?? "";

  return {
    sid: parseNumericAttr(header?.attrs.sid),
    recipientDeviceIds,
    payloadBytes: Buffer.byteLength(payload, "utf8"),
    isPreKeyMessage: elementChildren(header, "keys")
      .flatMap((keys) => elementChildren(keys, "key"))
      .some((key) => key.attrs.kex === "true" || key.attrs.prekey === "true"),
    decrypted: false,
  };
}

export function extractDeviceList(items: XmppElement | null): number[] {
  const item = items?.getChild("item") ?? null;
  const list =
    findChildByName(item, ["devices", "list"], NS_OMEMO) ??
    findChildByName(items, ["devices", "list"], NS_OMEMO) ??
    findChildByName(item, ["devices", "list"]) ??
    findChildByName(items, ["devices", "list"]);
  return uniqueSortedNumbers(
    elementChildren(list, "device")
      .map((device) => parseNumericAttr(device.attrs.id))
      .filter((value): value is number => value !== undefined)
  );
}

export function parseBundle(items: XmppElement | null): {
  identityKey: ArrayBuffer;
  signedPreKey: { keyId: number; publicKey: ArrayBuffer; signature: ArrayBuffer };
  preKeys: Array<{ keyId: number; publicKey: ArrayBuffer }>;
} | null {
  const item = items?.getChild("item") ?? null;
  const bundle = item?.getChild("bundle", NS_OMEMO) ?? items?.getChild("bundle", NS_OMEMO);
  if (!bundle) return null;

  const identityKeyText = bundle.getChildText("ik", NS_OMEMO) ?? bundle.getChildText("identityKey", NS_OMEMO) ?? bundle.getChildText("ik") ?? bundle.getChildText("identityKey");
  const signedPreKeyEl =
    bundle.getChild("spk", NS_OMEMO) ??
    bundle.getChild("signedPreKeyPublic", NS_OMEMO) ??
    bundle.getChild("spk") ??
    bundle.getChild("signedPreKeyPublic");
  const signatureText =
    bundle.getChildText("spks", NS_OMEMO) ??
    bundle.getChildText("signedPreKeySignature", NS_OMEMO) ??
    bundle.getChildText("spks") ??
    bundle.getChildText("signedPreKeySignature");
  const prekeysEl = bundle.getChild("prekeys", NS_OMEMO) ?? bundle.getChild("prekeys");

  const signedPreKeyId = parseNumericAttr(signedPreKeyEl?.attrs.id ?? signedPreKeyEl?.attrs.signedPreKeyId);

  if (!identityKeyText || !signedPreKeyEl?.text?.() || !signatureText || !signedPreKeyId) {
    return null;
  }

  const preKeys = [...elementChildren(prekeysEl, "pk"), ...elementChildren(prekeysEl, "preKeyPublic")]
    .map((preKeyEl) => {
      const keyId = parseNumericAttr(preKeyEl.attrs.id ?? preKeyEl.attrs.preKeyId);
      const value = preKeyEl.text?.() ?? "";
      if (!keyId || !value) return null;
      return {
        keyId,
        publicKey: arrayBufferFromBase64(value),
      };
    })
    .filter((value): value is { keyId: number; publicKey: ArrayBuffer } => Boolean(value));

  return {
    identityKey: arrayBufferFromBase64(identityKeyText),
    signedPreKey: {
      keyId: signedPreKeyId,
      publicKey: arrayBufferFromBase64(signedPreKeyEl.text?.() ?? ""),
      signature: arrayBufferFromBase64(signatureText),
    },
    preKeys,
  };
}

class JsonSignalStorage implements StorageType {
  constructor(
    private readonly getState: () => XmppOmemoState,
    private readonly persist: () => Promise<void>,
    private readonly ensureContact: (jid: string) => XmppOmemoContactState
  ) {}

  async getIdentityKeyPair(): Promise<KeyPairType<ArrayBuffer> | undefined> {
    return deserializeKeyPair(this.getState().signal.identityKeyPair);
  }

  async getLocalRegistrationId(): Promise<number | undefined> {
    return this.getState().signal.registrationId;
  }

  async isTrustedIdentity(
    _identifier: string,
    _identityKey: ArrayBuffer,
    _direction: SignalDirection
  ): Promise<boolean> {
    return true;
  }

  async saveIdentity(
    encodedAddress: string,
    publicKey: ArrayBuffer,
    _nonblockingApproval?: boolean
  ): Promise<boolean> {
    const state = this.getState();
    const previous = state.signal.identities[encodedAddress];
    const serialized = base64FromArrayBuffer(publicKey);
    const timestamp = nowIso();
    state.signal.identities[encodedAddress] = {
      publicKey: serialized,
      firstSeenAt: previous?.firstSeenAt ?? timestamp,
      lastSeenAt: timestamp,
    };

    const address = parseEncodedAddress(encodedAddress);
    if (address) {
      const contact = this.ensureContact(address.name);
      const devices = contact.devices ?? {};
      const existing = devices[String(address.deviceId)] ?? { deviceId: address.deviceId };
      existing.fingerprint = bufferFingerprint(publicKey);
      devices[String(address.deviceId)] = existing;
      contact.devices = devices;
    }

    await this.persist();
    return previous?.publicKey !== serialized;
  }

  async loadPreKey(encodedAddress: string | number): Promise<KeyPairType<ArrayBuffer> | undefined> {
    return deserializeKeyPair(this.getState().signal.preKeys[String(encodedAddress)]);
  }

  async storePreKey(keyId: number | string, keyPair: KeyPairType<ArrayBuffer>): Promise<void> {
    this.getState().signal.preKeys[String(keyId)] = serializeKeyPair(keyPair);
    await this.persist();
  }

  async removePreKey(keyId: number | string): Promise<void> {
    delete this.getState().signal.preKeys[String(keyId)];
    await this.persist();
  }

  async storeSession(encodedAddress: string, record: string): Promise<void> {
    this.getState().signal.sessions[encodedAddress] = record;
    await this.persist();
  }

  async loadSession(encodedAddress: string): Promise<string | undefined> {
    return this.getState().signal.sessions[encodedAddress];
  }

  async loadSignedPreKey(keyId: number | string): Promise<KeyPairType<ArrayBuffer> | undefined> {
    return deserializeKeyPair(this.getState().signal.signedPreKeys[String(keyId)]);
  }

  async storeSignedPreKey(keyId: number | string, keyPair: KeyPairType<ArrayBuffer>): Promise<void> {
    const state = this.getState();
    const existing = state.signal.signedPreKeys[String(keyId)];
    state.signal.signedPreKeys[String(keyId)] = {
      keyId: Number(keyId),
      signature: existing?.signature ?? "",
      createdAt: existing?.createdAt ?? nowIso(),
      ...serializeKeyPair(keyPair),
    };
    await this.persist();
  }

  async removeSignedPreKey(keyId: number | string): Promise<void> {
    delete this.getState().signal.signedPreKeys[String(keyId)];
    await this.persist();
  }
}

class DefaultXmppOmemoController implements XmppOmemoController {
  readonly config: ResolvedXmppOmemoConfig;
  readonly statePath: string;

  private readonly account: ResolvedXmppAccount;
  private readonly client: XmppClient;
  private readonly log?: XmppOmemoLogger;
  private readonly setStatus?: XmppOmemoStatusSink;
  private state: XmppOmemoState;
  private readonly signalStore: JsonSignalStorage;
  private opQueue: Promise<void> = Promise.resolve();
  private persistQueue: Promise<void> = Promise.resolve();
  private maintenanceScheduled = false;
  private stopped = false;

  constructor(params: CreateXmppOmemoControllerParams) {
    this.account = params.account;
    this.client = params.client;
    this.log = params.log;
    this.setStatus = params.setStatus;
    this.config = params.account.omemo;
    this.statePath = resolveStatePath(params.account);
    this.state = createEmptyState(params.account);
    this.signalStore = new JsonSignalStorage(
      () => this.state,
      async () => await this.persistState(),
      (jid) => this.ensureContact(jid)
    );
  }

  async initialize(): Promise<void> {
    await this.runExclusive(async () => {
      this.state = await this.loadState();
      await this.ensureLocalKeys();
      await this.ensureEnoughPreKeys();
      if (this.config.mode !== "off") {
        await this.publishOwnDeviceListAndBundle();
      }
      await this.persistState();
      this.publishStatus();
    });
  }

  async beforeSend(params: {
    to: string;
    chatType: "direct" | "channel";
    text: string;
    messageId: string;
  }): Promise<XmppElement | null> {
    if (params.chatType !== "direct") {
      return null;
    }

    return await this.runExclusive(async () => {
      const to = normalizeContactJid(params.to);
      const contact = this.ensureContact(to);

      if (this.config.mode === "off") {
        contact.lastPlaintextOutboundAt = nowIso();
        await this.persistState();
        return null;
      }

      try {
        const stanza = await this.buildEncryptedMessage(params.messageId, to, params.text);
        contact.lastEncryptedOutboundAt = nowIso();
        this.state.interoperability.lastSuccessfulEncryptionAt = contact.lastEncryptedOutboundAt;
        this.state.interoperability.lastWarning = undefined;
        await this.persistState();
        this.publishStatus({ omemoFallback: undefined, omemoLastEncryptedTo: to });
        return stanza;
      } catch (error) {
        const message = String(error);
        if (this.config.mode === "required") {
          this.recordPolicyViolation(contact, "outbound", message);
          await this.persistState();
          throw new Error(`XMPP OMEMO required for ${to}, but ${message}`);
        }

        if (!this.config.allowUnencryptedFallback) {
          this.recordPolicyViolation(contact, "outbound", message);
          await this.persistState();
          throw new Error(`XMPP OMEMO is enabled for ${to}, but ${message}`);
        }

        contact.lastPlaintextOutboundAt = nowIso();
        this.state.interoperability.lastWarning = `falling back to plaintext for ${to}: ${message}`;
        this.log?.warn?.(`[${this.account.accountId}] ${this.state.interoperability.lastWarning}`);
        await this.persistState();
        this.publishStatus({ omemoFallback: "plaintext" });
        return null;
      }
    });
  }

  async afterPlaintextSend(params: {
    to: string;
    chatType: "direct" | "channel";
    text: string;
  }): Promise<void> {
    if (params.chatType !== "direct") return;
    await this.runExclusive(async () => {
      const contact = this.ensureContact(normalizeContactJid(params.to));
      contact.lastPlaintextOutboundAt = nowIso();
      await this.persistState();
    });
  }

  async handleInboundEncryptedDm(params: {
    from: string;
    stanza: XmppElement;
    reply?: (text: string) => Promise<void>;
  }): Promise<XmppOmemoEncryptedReceiveResult> {
    return await this.runExclusive(async () => {
      const snapshot = extractOmemoEncryptedSnapshot(params.stanza);
      if (!snapshot) {
        return { handled: false };
      }

      const from = normalizeContactJid(params.from);
      const contact = this.ensureContact(from);
      contact.lastEncryptedInboundAt = nowIso();
      contact.lastEncryptedInbound = snapshot;

      try {
        const decrypted = await this.decryptInboundMessage(from, params.stanza);
        snapshot.decrypted = true;
        contact.lastEncryptedInbound = snapshot;
        this.state.interoperability.lastSuccessfulDecryptionAt = contact.lastEncryptedInboundAt;
        this.state.interoperability.lastWarning = undefined;
        await this.persistState();
        this.scheduleMaintenance();
        this.publishStatus({
          omemoLastEncryptedFrom: from,
          omemoLastEncryptedAt: contact.lastEncryptedInboundAt,
          omemoEncryptedInboundUnsupported: false,
        });
        return { handled: true, body: decrypted };
      } catch (error) {
        const message = String(error);
        this.state.interoperability.lastWarning = `received OMEMO payload from ${from}, but decryption failed: ${message}`;
        await this.persistState();
        this.publishStatus({
          omemoLastEncryptedFrom: from,
          omemoLastEncryptedAt: contact.lastEncryptedInboundAt,
          omemoEncryptedInboundUnsupported: true,
        });
        this.log?.warn?.(`[${this.account.accountId}] failed decrypting OMEMO XMPP DM from ${from}: ${message}`);

        if (this.config.replyOnUnsupportedInbound && params.reply) {
          await params.reply(
            "I received an OMEMO-encrypted XMPP message, but I could not decrypt it. Please resend or let me refresh the session."
          );
        }

        return { handled: true };
      }
    });
  }

  async allowInboundPlaintextDm(params: {
    from: string;
    body: string;
    reply?: (text: string) => Promise<void>;
  }): Promise<boolean> {
    return await this.runExclusive(async () => {
      const from = normalizeContactJid(params.from);
      const contact = this.ensureContact(from);
      contact.lastPlaintextInboundAt = nowIso();

      if (this.config.mode !== "required") {
        await this.persistState();
        return true;
      }

      const reason = "plaintext inbound DM rejected because OMEMO is required";
      this.recordPolicyViolation(contact, "inbound", reason);
      this.state.interoperability.lastWarning = reason;
      await this.persistState();
      this.publishStatus({ omemoLastRejectedPlaintextFrom: from });
      this.log?.warn?.(`[${this.account.accountId}] rejected plaintext XMPP DM from ${from} because OMEMO is required`);

      if (this.config.replyOnUnsupportedInbound && params.reply) {
        await params.reply("Plaintext XMPP direct messages are disabled here because OMEMO is required.");
      }

      return false;
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.runExclusive(async () => {
      await this.persistState();
    });
  }

  private async ensureLocalKeys(): Promise<void> {
    const state = this.state.signal;
    const identity = deserializeKeyPair(state.identityKeyPair);
    if (!identity || identity.pubKey.byteLength === 0 || identity.privKey.byteLength === 0) {
      const identityKeyPair = await KeyHelper.generateIdentityKeyPair();
      state.identityKeyPair = serializeKeyPair(identityKeyPair);
    }

    const activeSigned = state.signedPreKeys[String(state.activeSignedPreKeyId)];
    if (!activeSigned || !activeSigned.signature) {
      const identityKeyPair = deserializeKeyPair(state.identityKeyPair);
      if (!identityKeyPair) {
        throw new Error("OMEMO identity key generation failed");
      }
      const signedPreKey = await KeyHelper.generateSignedPreKey(identityKeyPair, state.activeSignedPreKeyId);
      state.signedPreKeys[String(state.activeSignedPreKeyId)] = {
        keyId: state.activeSignedPreKeyId,
        signature: base64FromArrayBuffer(signedPreKey.signature),
        createdAt: nowIso(),
        ...serializeKeyPair(signedPreKey.keyPair),
      };
      state.nextSignedPreKeyId = Math.max(state.nextSignedPreKeyId, state.activeSignedPreKeyId + 1);
    }
  }

  private async ensureEnoughPreKeys(): Promise<void> {
    const state = this.state.signal;
    const existing = Object.keys(state.preKeys).length;
    if (existing >= PREKEY_LOW_WATERMARK) {
      return;
    }

    const missing = PREKEY_TARGET_COUNT - existing;
    for (let index = 0; index < missing; index += 1) {
      const keyId = state.nextPreKeyId;
      const preKey = await KeyHelper.generatePreKey(keyId);
      state.preKeys[String(keyId)] = serializeKeyPair(preKey.keyPair);
      state.nextPreKeyId += 1;
    }
  }

  private async loadState(): Promise<XmppOmemoState> {
    try {
      const raw = await readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<XmppOmemoState>;
      const legacyInteroperability = (parsed.interoperability ?? {}) as Partial<
        XmppOmemoState["interoperability"]
      >;
      const state = {
        ...createEmptyState(this.account),
        ...parsed,
        version: 2 as const,
        accountId: this.account.accountId,
        accountJid: this.account.jid,
        contacts: parsed.contacts ?? {},
        interoperability: {
          cryptoImplemented: true as const,
          bundlePublishingImplemented: true as const,
          lastWarning: legacyInteroperability.lastWarning,
          lastSuccessfulEncryptionAt: legacyInteroperability.lastSuccessfulEncryptionAt,
          lastSuccessfulDecryptionAt: legacyInteroperability.lastSuccessfulDecryptionAt,
        },
        signal: {
          ...createEmptyState(this.account).signal,
          ...(parsed as any).signal,
          identities: (parsed as any).signal?.identities ?? {},
          sessions: (parsed as any).signal?.sessions ?? {},
          preKeys: (parsed as any).signal?.preKeys ?? {},
          signedPreKeys: (parsed as any).signal?.signedPreKeys ?? {},
        },
      } satisfies XmppOmemoState;
      return state;
    } catch (error) {
      const message = String(error);
      if (!message.includes("ENOENT")) {
        this.log?.warn?.(`[${this.account.accountId}] failed reading OMEMO state, recreating: ${message}`);
      }
      return createEmptyState(this.account);
    }
  }

  private async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.opQueue;
    this.opQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private scheduleMaintenance(): void {
    if (this.maintenanceScheduled || this.stopped || this.config.mode === "off") {
      return;
    }
    this.maintenanceScheduled = true;
    queueMicrotask(() => {
      void this.runExclusive(async () => {
        this.maintenanceScheduled = false;
        if (this.stopped || this.config.mode === "off") {
          return;
        }
        await this.ensureEnoughPreKeys();
        await this.publishOwnDeviceListAndBundle();
        await this.persistState();
      }).catch((error) => {
        this.maintenanceScheduled = false;
        this.log?.warn?.(
          `[${this.account.accountId}] OMEMO maintenance failed: ${String(error)}`
        );
      });
    });
  }

  private async persistState(): Promise<void> {
    this.state.updatedAt = nowIso();
    const snapshot = JSON.stringify(this.state, null, 2) + "\n";
    this.persistQueue = this.persistQueue
      .catch(() => {})
      .then(async () => {
        await mkdir(path.dirname(this.statePath), { recursive: true });
        await writeFile(this.statePath, snapshot, "utf8");
      });
    await this.persistQueue;
  }

  private ensureContact(raw: string): XmppOmemoContactState {
    const bareJid = normalizeContactJid(raw);
    const existing = this.state.contacts[bareJid];
    if (existing) {
      existing.bareJid = bareJid;
      return existing;
    }

    const created: XmppOmemoContactState = { bareJid };
    this.state.contacts[bareJid] = created;
    return created;
  }

  private recordPolicyViolation(
    contact: XmppOmemoContactState,
    direction: "inbound" | "outbound",
    reason: string
  ): void {
    const violations = contact.policyViolations ?? [];
    violations.push({ at: nowIso(), direction, reason });
    contact.policyViolations = violations.slice(-MAX_POLICY_VIOLATIONS);
  }

  private publishStatus(extra: Record<string, unknown> = {}): void {
    this.setStatus?.({
      accountId: this.account.accountId,
      omemoMode: this.config.mode,
      omemoCryptoImplemented: true,
      omemoBundlePublishingImplemented: true,
      omemoStatePath: this.statePath,
      omemoInterop: "signal-v3",
      omemoDeviceId: this.state.signal.deviceId,
      omemoPreKeysAvailable: Object.keys(this.state.signal.preKeys).length,
      ...extra,
    });
  }

  private async refreshRecipientDeviceList(to: string): Promise<XmppOmemoDeviceListResult> {
    const contact = this.ensureContact(to);
    const previous = contact.deviceList;
    if (previous) {
      const ageMs = Date.now() - Date.parse(previous.fetchedAt);
      if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < DEVICE_LIST_CACHE_TTL_MS) {
        return previous;
      }
    }

    try {
      const items = await this.fetchPubsubItems(to, OMEMO_DEVICELIST_NODE);
      if (!items) {
        const snapshot: XmppOmemoDeviceListResult = {
          fetchedAt: nowIso(),
          deviceIds: [],
          fetchError: "xmpp iqCaller unavailable",
        };
        contact.deviceList = snapshot;
        await this.persistState();
        return snapshot;
      }

      const snapshot: XmppOmemoDeviceListResult = {
        fetchedAt: nowIso(),
        deviceIds: extractDeviceList(items),
      };
      contact.deviceList = snapshot;
      await this.persistState();
      return snapshot;
    } catch (error) {
      const snapshot: XmppOmemoDeviceListResult = {
        fetchedAt: nowIso(),
        deviceIds: [],
        fetchError: String(error),
      };
      if (isXmppItemNotFoundError(error)) {
        delete snapshot.fetchError;
        this.log?.info?.(
          `[${this.account.accountId}] OMEMO device-list node missing for ${to}, treating as empty`
        );
      } else {
        this.log?.warn?.(
          `[${this.account.accountId}] OMEMO device-list fetch failed for ${to}: ${snapshot.fetchError}`
        );
      }
      contact.deviceList = snapshot;
      await this.persistState();
      return snapshot;
    }
  }

  private async refreshRecipientBundle(to: string, deviceId: number): Promise<XmppOmemoBundleResult> {
    const contact = this.ensureContact(to);
    const devices = contact.devices ?? {};
    const existing = devices[String(deviceId)] ?? { deviceId };
    contact.devices = devices;

    const previous = existing.bundle;
    if (previous && !previous.fetchError) {
      const ageMs = Date.now() - Date.parse(previous.fetchedAt);
      if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < BUNDLE_CACHE_TTL_MS) {
        return {
          fetchedAt: previous.fetchedAt,
          fingerprint: previous.fingerprint,
          signedPreKeyId: previous.signedPreKeyId,
          preKeyIds: previous.preKeyIds,
          bundle: previous.preKeyIds.length
            ? await this.fetchBundleFromSnapshot(to, deviceId, previous)
            : undefined,
        };
      }
    }

    try {
      const items = await this.fetchPubsubItems(to, OMEMO_BUNDLES_NODE, String(deviceId));
      if (!items) {
        throw new Error("xmpp iqCaller unavailable");
      }
      const parsed = parseBundle(items);
      if (!parsed) {
        throw new Error("bundle missing or malformed");
      }
      const selectedPreKey = parsed.preKeys[Math.floor(Math.random() * parsed.preKeys.length)] ?? parsed.preKeys[0];
      if (!selectedPreKey) {
        throw new Error("bundle has no prekeys");
      }

      const result: XmppOmemoBundleResult = {
        fetchedAt: nowIso(),
        fingerprint: bufferFingerprint(parsed.identityKey),
        signedPreKeyId: parsed.signedPreKey.keyId,
        preKeyIds: parsed.preKeys.map((preKey) => preKey.keyId),
        bundle: {
          identityKey: parsed.identityKey,
          signedPreKey: parsed.signedPreKey,
          preKey: selectedPreKey,
        },
      };

      existing.fingerprint = result.fingerprint!;
      existing.bundle = {
        fetchedAt: result.fetchedAt,
        fingerprint: result.fingerprint!,
        signedPreKeyId: result.signedPreKeyId!,
        preKeyIds: result.preKeyIds ?? [],
      };
      devices[String(deviceId)] = existing;
      await this.persistState();
      return result;
    } catch (error) {
      const result: XmppOmemoBundleResult = {
        fetchedAt: nowIso(),
        fetchError: String(error),
      };
      existing.bundle = {
        fetchedAt: result.fetchedAt,
        fingerprint: existing.fingerprint ?? "",
        signedPreKeyId: 0,
        preKeyIds: [],
        fetchError: result.fetchError,
      };
      devices[String(deviceId)] = existing;
      await this.persistState();
      this.log?.warn?.(
        `[${this.account.accountId}] OMEMO bundle fetch failed for ${to} device ${deviceId}: ${result.fetchError}`
      );
      return result;
    }
  }

  private async fetchBundleFromSnapshot(
    to: string,
    deviceId: number,
    snapshot: XmppOmemoBundleSnapshot
  ): Promise<DeviceType<ArrayBuffer> | undefined> {
    const result = await this.refreshRecipientBundleFresh(to, deviceId, snapshot);
    return result.bundle;
  }

  private async refreshRecipientBundleFresh(
    to: string,
    deviceId: number,
    _snapshot: XmppOmemoBundleSnapshot
  ): Promise<XmppOmemoBundleResult> {
    const items = await this.fetchPubsubItems(to, OMEMO_BUNDLES_NODE, String(deviceId));
    if (!items) {
      return { fetchedAt: nowIso(), fetchError: "xmpp iqCaller unavailable" };
    }
    const parsed = parseBundle(items);
    if (!parsed) {
      return { fetchedAt: nowIso(), fetchError: "bundle missing or malformed" };
    }
    const selectedPreKey = parsed.preKeys[Math.floor(Math.random() * parsed.preKeys.length)] ?? parsed.preKeys[0];
    if (!selectedPreKey) {
      return { fetchedAt: nowIso(), fetchError: "bundle has no prekeys" };
    }
    return {
      fetchedAt: nowIso(),
      fingerprint: bufferFingerprint(parsed.identityKey),
      signedPreKeyId: parsed.signedPreKey.keyId,
      preKeyIds: parsed.preKeys.map((preKey) => preKey.keyId),
      bundle: {
        identityKey: parsed.identityKey,
        signedPreKey: parsed.signedPreKey,
        preKey: selectedPreKey,
      },
    };
  }

  private async buildEncryptedMessage(
    messageId: string,
    to: string,
    text: string
  ): Promise<XmppElement> {
    const recipientBareJid = normalizeContactJid(to);
    const senderBareJid = normalizeContactJid(this.account.jid);
    const deviceList = await this.refreshRecipientDeviceList(recipientBareJid);
    if (deviceList.fetchError) {
      throw new Error(`recipient device discovery failed: ${deviceList.fetchError}`);
    }
    if (deviceList.deviceIds.length === 0) {
      throw new Error("recipient has no published OMEMO device list");
    }

    const payload = await this.encryptPayload(text, senderBareJid);
    const recipientKeyElements: XmppElement[] = [];
    const errors: string[] = [];

    for (const deviceId of deviceList.deviceIds) {
      try {
        const address = new SignalProtocolAddress(recipientBareJid, deviceId);
        const cipher = new SessionCipher(this.signalStore, address);
        const existingSession = await cipher.hasOpenSession();
        if (!existingSession) {
          const bundleResult = await this.refreshRecipientBundle(recipientBareJid, deviceId);
          if (!bundleResult.bundle) {
            throw new Error(bundleResult.fetchError ?? "recipient bundle unavailable");
          }
          const builder = new SessionBuilder(this.signalStore, address);
          await builder.processPreKey(bundleResult.bundle);
        }

        const encryptedKey = await cipher.encrypt(payload.keyAndTag);
        const attrs: Record<string, string> = { rid: String(deviceId) };
        if (encryptedKey.type === 3) {
          attrs.kex = "true";
        }
        recipientKeyElements.push(
          xml("key", attrs, base64FromArrayBuffer(arrayBufferFromBinaryString(encryptedKey.body ?? "")))
        );
      } catch (error) {
        errors.push(`device ${deviceId}: ${String(error)}`);
      }
    }

    if (recipientKeyElements.length === 0) {
      throw new Error(errors[0] ?? "unable to encrypt for any recipient device");
    }

    if (errors.length > 0) {
      this.log?.warn?.(
        `[${this.account.accountId}] partial OMEMO encryption for ${recipientBareJid}: ${errors.join("; ")}`
      );
    }

    return xml(
      "message",
      { id: messageId, to, type: "chat" },
      xml(
        "encrypted",
        { xmlns: NS_OMEMO },
        xml("header", { sid: String(this.state.signal.deviceId) }, buildOmemoKeysElement(recipientBareJid, recipientKeyElements)),
        xml("payload", {}, payload.payload)
      ),
      xml("store", { xmlns: NS_HINTS }),
      xml("encryption", { xmlns: NS_EME, namespace: NS_OMEMO })
    );
  }

  private async encryptPayload(text: string, from: string): Promise<XmppOmemoPayloadMaterial> {
    const plaintext = utf8ArrayBuffer(buildOmemoSceEnvelope(text, from).toString());
    const key = randomBytes(PAYLOAD_KEY_BYTES);
    const derived = new Uint8Array(await hkdfSha256(key, HKDF_INFO_PAYLOAD, HKDF_BYTES));
    const encryptionKey = asArrayBuffer(derived.slice(0, 32));
    const authenticationKey = asArrayBuffer(derived.slice(32, 64));
    const iv = asArrayBuffer(derived.slice(64, 80));
    const keyObject = await webcrypto.subtle.importKey(
      "raw",
      encryptionKey,
      { name: "AES-CBC", length: AES_PAYLOAD_KEY_LENGTH },
      false,
      ["encrypt", "decrypt"]
    );
    const ciphertext = await webcrypto.subtle.encrypt(
      { name: "AES-CBC", iv: new Uint8Array(iv) },
      keyObject,
      plaintext
    );
    const tag = truncateArrayBuffer(await hmacSha256(authenticationKey, ciphertext), TAG_BYTES);
    return {
      key,
      tag,
      keyAndTag: concatArrayBuffers(key, tag),
      payload: base64FromArrayBuffer(ciphertext),
    };
  }

  private async decryptInboundMessage(from: string, stanza: XmppElement): Promise<string> {
    const encrypted = stanza.getChild("encrypted", NS_OMEMO);
    const header = encrypted?.getChild("header", NS_OMEMO) ?? encrypted?.getChild("header");
    const payloadText = encrypted?.getChildText("payload", NS_OMEMO) ?? encrypted?.getChildText("payload");
    const sid = parseNumericAttr(header?.attrs.sid);

    if (!header || !sid) {
      throw new Error("missing OMEMO header sid");
    }

    const decryptedHeader = await this.decryptHeaderKey(from, sid, header);
    if (!payloadText) {
      throw new Error("OMEMO key transport message received without payload support");
    }

    const payloadBytes = arrayBufferFromBase64(payloadText);
    const derived = new Uint8Array(await hkdfSha256(decryptedHeader.key, HKDF_INFO_PAYLOAD, HKDF_BYTES));
    const encryptionKey = asArrayBuffer(derived.slice(0, 32));
    const authenticationKey = asArrayBuffer(derived.slice(32, 64));
    const iv = asArrayBuffer(derived.slice(64, 80));
    const actualTag = truncateArrayBuffer(await hmacSha256(authenticationKey, payloadBytes), TAG_BYTES);
    if (!timingSafeEqual(Buffer.from(actualTag), Buffer.from(decryptedHeader.tag))) {
      throw new Error("OMEMO payload authentication failed");
    }
    const keyObject = await webcrypto.subtle.importKey(
      "raw",
      encryptionKey,
      { name: "AES-CBC", length: AES_PAYLOAD_KEY_LENGTH },
      false,
      ["encrypt", "decrypt"]
    );
    const plaintext = await webcrypto.subtle.decrypt(
      {
        name: "AES-CBC",
        iv: new Uint8Array(iv),
      },
      keyObject,
      payloadBytes
    );
    const envelope = utf8FromArrayBuffer(plaintext);
    return extractBodyFromSceEnvelopeString(envelope) ?? envelope;
  }

  private async decryptHeaderKey(
    from: string,
    sid: number,
    header: XmppElement
  ): Promise<XmppOmemoDecryptedHeader> {
    const ourDeviceId = this.state.signal.deviceId;
    const ownBareJid = normalizeContactJid(this.account.jid);
    const keysEl = elementChildren(header, "keys").find(
      (candidate) => normalizeXmppBareJid(candidate.attrs.jid) === ownBareJid
    );
    const keyEl = elementChildren(keysEl, "key").find(
      (candidate) => parseNumericAttr(candidate.attrs.rid) === ourDeviceId
    );
    if (!keyEl?.text?.()) {
      throw new Error(`no OMEMO header key for local device ${ourDeviceId}`);
    }

    const encryptedKey = arrayBufferFromBase64(keyEl.text());
    const address = new SignalProtocolAddress(from, sid);
    const cipher = new SessionCipher(this.signalStore, address);
    const decrypted = keyEl.attrs.kex === "true" || keyEl.attrs.prekey === "true"
      ? await cipher.decryptPreKeyWhisperMessage(binaryStringFromArrayBuffer(encryptedKey), "binary")
      : await cipher.decryptWhisperMessage(binaryStringFromArrayBuffer(encryptedKey), "binary");

    const raw = new Uint8Array(decrypted);
    if (raw.byteLength < PAYLOAD_KEY_BYTES + TAG_BYTES) {
      throw new Error(`invalid decrypted OMEMO key material length ${raw.byteLength}`);
    }

    return {
      key: asArrayBuffer(raw.slice(0, PAYLOAD_KEY_BYTES)),
      tag: asArrayBuffer(raw.slice(PAYLOAD_KEY_BYTES, PAYLOAD_KEY_BYTES + TAG_BYTES)),
      sid,
      isPreKey: keyEl.attrs.kex === "true" || keyEl.attrs.prekey === "true",
    };
  }

  private async publishOwnDeviceListAndBundle(): Promise<void> {
    await this.ensureOwnDeviceOnPublishedList();
    await this.publishOwnBundle();
  }

  private async ensureOwnDeviceOnPublishedList(): Promise<void> {
    const ownBareJid = normalizeContactJid(this.account.jid);
    const current = await this.refreshRecipientDeviceList(ownBareJid);
    const deviceIds = uniqueSortedNumbers([...current.deviceIds, this.state.signal.deviceId]);
    await this.publishPubsubNode(OMEMO_DEVICELIST_NODE, buildOmemoDeviceListItem(deviceIds), {
      "pubsub#access_model": "open",
    });
    const contact = this.ensureContact(ownBareJid);
    contact.deviceList = { fetchedAt: nowIso(), deviceIds };
    await this.persistState();
  }

  private async publishOwnBundle(): Promise<void> {
    const activeSignedPreKey = this.state.signal.signedPreKeys[String(this.state.signal.activeSignedPreKeyId)];
    if (!activeSignedPreKey?.signature) {
      throw new Error("active OMEMO signed prekey missing");
    }

    const preKeyEntries = Object.entries(this.state.signal.preKeys)
      .map(([keyId, pair]) => ({ keyId: Number(keyId), pair }))
      .sort((a, b) => a.keyId - b.keyId);

    await this.publishPubsubNode(
      OMEMO_BUNDLES_NODE,
      buildOmemoBundleItem(
        this.state.signal.deviceId,
        activeSignedPreKey,
        preKeyEntries,
        this.state.signal.identityKeyPair
      ),
      {
        "pubsub#access_model": "open",
        "pubsub#max_items": "max",
      }
    );

    this.state.signal.lastBundlePublishedAt = nowIso();
    await this.persistState();
  }

  private async fetchPubsubItems(
    to: string | undefined,
    node: string,
    itemId?: string
  ): Promise<XmppElement | null> {
    const query = xml(
      "pubsub",
      { xmlns: NS_PUBSUB },
      xml("items", { node }, ...(itemId ? [xml("item", { id: itemId })] : []))
    );
    const iqCaller = this.client.iqCaller;
    if (iqCaller?.get) {
      return await iqCaller.get(query, to, 10_000);
    }
    if (iqCaller?.request) {
      return await iqCaller.request(
        xml("iq", { type: "get", to, id: `omemo-${randomUUID()}` }, query),
        10_000
      );
    }
    return null;
  }

  private async publishPubsubNode(
    node: string,
    item: XmppElement,
    publishOptions?: Record<string, string>
  ): Promise<void> {
    const stanza = xml(
      "pubsub",
      { xmlns: NS_PUBSUB },
      xml("publish", { node }, item),
      ...(publishOptions ? [buildPubsubPublishOptions(publishOptions)] : [])
    );
    const iqCaller = this.client.iqCaller;
    if (iqCaller?.set) {
      await iqCaller.set(stanza, undefined, 10_000);
      return;
    }
    if (iqCaller?.request) {
      await iqCaller.request(
        xml("iq", { type: "set", id: `omemo-${randomUUID()}` }, stanza),
        10_000
      );
      return;
    }
    throw new Error("xmpp iqCaller unavailable");
  }
}

export async function createXmppOmemoController(
  params: CreateXmppOmemoControllerParams
): Promise<XmppOmemoController> {
  const controller = new DefaultXmppOmemoController(params);
  await controller.initialize();
  return controller;
}
