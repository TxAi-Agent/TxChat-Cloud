export type SmsSendRequest = Readonly<{
  phone: string;
  code: string;
  challengeId: string;
}>;

export type SmsRejectionCategory =
  | "configuration"
  | "invalid_request"
  | "provider_business"
  | "unknown_business";

export type SmsUncertainCategory =
  | "transport_after_dispatch"
  | "malformed_response";

export type SmsDeliveryOutcome =
  | Readonly<{ kind: "accepted" }>
  | Readonly<{
      kind: "rejected";
      category: SmsRejectionCategory;
    }>
  | Readonly<{
      kind: "uncertain";
      category: SmsUncertainCategory;
    }>;

export interface SmsProvider {
  send(request: SmsSendRequest): Promise<SmsDeliveryOutcome>;
}

export type SmsTransportRequest = SmsSendRequest;

export interface SmsTransport {
  send(request: SmsTransportRequest): Promise<SmsDeliveryOutcome>;
}

export class ProductionSmsProvider implements SmsProvider {
  private readonly transport: SmsTransport;

  constructor(options: {
    transport?: SmsTransport;
  }) {
    if (options.transport === undefined) {
      throw new Error("SMS production transport is unavailable");
    }
    this.transport = options.transport;
  }

  async send(request: SmsSendRequest): Promise<SmsDeliveryOutcome> {
    return this.transport.send(request);
  }
}

export class FailClosedSmsProvider implements SmsProvider {
  async send(_request: SmsSendRequest): Promise<SmsDeliveryOutcome> {
    return { kind: "rejected", category: "configuration" };
  }
}
