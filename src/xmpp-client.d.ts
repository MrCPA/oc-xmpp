declare module "@xmpp/client" {
  import { EventEmitter } from "node:events";

  export interface XmppElement {
    attrs: Record<string, string | undefined>;
    is(name: string, xmlns?: string): boolean;
    getChild(name: string, xmlns?: string): XmppElement | null;
    getChildren?(name: string, xmlns?: string): XmppElement[];
    getChildElements?(): XmppElement[];
    getChildText(name: string, xmlns?: string): string | null;
    append?(child: XmppElement): void;
    text?(): string;
    toString(): string;
  }

  export interface XmppJid {
    local?: string;
    domain?: string;
    resource?: string;
    toString(): string;
  }

  export interface XmppClient extends EventEmitter {
    status?: string;
    jid?: XmppJid;
    iqCaller?: {
      get(element: XmppElement, to?: string, timeout?: number): Promise<XmppElement | null>;
      set?(element: XmppElement, to?: string, timeout?: number): Promise<XmppElement | null>;
      request?(stanza: XmppElement, timeout?: number): Promise<XmppElement>;
    };
    start(): Promise<void>;
    stop(): Promise<void>;
    disconnect(): Promise<void>;
    send(stanza: XmppElement): Promise<unknown>;
    sendReceive?(stanza: XmppElement, timeout?: number): Promise<XmppElement>;
  }

  export function client(options: {
    service: string;
    domain?: string;
    resource?: string;
    username?: string;
    password?: string;
    timeout?: number;
  }): XmppClient;

  export function xml(
    name: string,
    attrs?: Record<string, unknown> | null,
    ...children: unknown[]
  ): XmppElement;
}
