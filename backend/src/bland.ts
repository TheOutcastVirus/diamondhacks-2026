import type { AppConfig } from "./config";

export type BlandCallResult = {
  status: string;
  callId: string;
};

type BlandCallInput = {
  phoneNumber: string;
  pathwayId?: string;
};

const E164_PHONE_PATTERN = /^\+[1-9]\d{7,14}$/;

function normalizePhoneNumber(phoneNumber: string): string {
  const normalized = phoneNumber.trim().replace(/[\s()-]+/g, "");
  if (!E164_PHONE_PATTERN.test(normalized)) {
    throw new Error("Family contact phone number must be stored in E.164 format.");
  }
  return normalized;
}

export class BlandService {
  constructor(private readonly config: AppConfig) {}

  isConfigured(): boolean {
    return Boolean(this.config.bland.apiKey?.trim() && this.config.bland.pathwayId?.trim());
  }

  async placePathwayCall(input: BlandCallInput): Promise<BlandCallResult> {
    const apiKey = this.config.bland.apiKey?.trim();
    if (!apiKey) {
      throw new Error("BLAND_API_KEY is not configured.");
    }

    const pathwayId = input.pathwayId?.trim() || this.config.bland.pathwayId?.trim();
    if (!pathwayId) {
      throw new Error("BLAND_PATHWAY_ID is not configured.");
    }

    const phoneNumber = normalizePhoneNumber(input.phoneNumber);
    const response = await fetch(`${this.config.bland.baseUrl}/v1/calls`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: apiKey,
      },
      body: JSON.stringify({
        phone_number: phoneNumber,
        pathway_id: pathwayId,
      }),
    });

    const bodyText = await response.text();
    let payload: Record<string, unknown> | null = null;
    try {
      payload = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      throw new Error(`Bland API error ${response.status}: ${bodyText}`);
    }

    const status = typeof payload?.status === "string" ? payload.status : "";
    const callId = typeof payload?.call_id === "string" ? payload.call_id : "";
    if (!status || !callId) {
      throw new Error("Bland API returned an unexpected response.");
    }

    return { status, callId };
  }
}
