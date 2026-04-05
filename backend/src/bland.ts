import type { AppConfig } from "./config";

export type BlandCallResult = {
  status: string;
  callId: string;
};

type BlandCallInput = {
  phoneNumber: string;
  pathwayId?: string;
  /** Passed to Bland as `request_data` — available as variables inside the pathway when the call connects. */
  requestData?: Record<string, string>;
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
    return Boolean(this.config.bland.apiKey?.trim());
  }

  async placePathwayCall(input: BlandCallInput): Promise<BlandCallResult> {
    const apiKey = this.config.bland.apiKey?.trim();
    if (!apiKey) {
      throw new Error("BLAND_API_KEY is not configured.");
    }

    const pathwayId = input.pathwayId?.trim() || this.config.bland.pathwayId?.trim();
    const phoneNumber = normalizePhoneNumber(input.phoneNumber);

    // If a pathway is configured, keep pathway mode. Otherwise, fall back to
    // direct call mode with explicit call options for emergency-family-call.
    const recentActivity =
      input.requestData?.recent_activity && String(input.requestData.recent_activity).trim().length > 0
        ? String(input.requestData.recent_activity).trim()
        : null;

    const baseTask =
      "You are calling a primary family contact for an urgent wellness alert. " +
      "Explain there may be a distress situation and they should try to reach their loved one " +
      "or ask someone nearby to check in immediately. " +
      "Use a calm, supportive tone. Ask if they have any questions, answer briefly, " +
      "and then ask them to confirm the next step they will take to help.";
    const task = recentActivity ? `${baseTask} Recent activity: ${recentActivity}.` : baseTask;

    const body: Record<string, unknown> = pathwayId
      ? {
        phone_number: phoneNumber,
        pathway_id: pathwayId,
      }
      : {
        phone_number: phoneNumber,
        task,
        voice: "0ad34a7c-ccd2-485c-977d-deb84bd23976",
        wait_for_greeting: false,
        record: true,
        answered_by_enabled: true,
        noise_cancellation: false,
        interruption_threshold: 500,
        block_interruptions: false,
        max_duration: 12,
        model: "base",
        language: "babel-en",
        background_track: "none",
        endpoint: this.config.bland.baseUrl,
        voicemail_action: "hangup",
      };
    if (pathwayId && input.requestData && Object.keys(input.requestData).length > 0) {
      body.request_data = input.requestData;
    }

    const response = await fetch(`${this.config.bland.baseUrl}/v1/calls`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: apiKey,
      },
      body: JSON.stringify(body),
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
