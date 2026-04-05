export type CrisisDetectionResult =
  | {
      triggered: false;
      normalizedMessage: string;
      matchedPhrases: string[];
    }
  | {
      triggered: true;
      reason: string;
      severity: "high";
      normalizedMessage: string;
      matchedPhrases: string[];
    };

const DISTRESS_PHRASES = [
  "im hurt",
  "i am hurt",
  "hurt",
  "injured",
  "i fell",
  "ive fallen",
  "i have fallen",
  "in trouble",
  "help me",
  "emergency",
];

const ACTION_PHRASES = [
  "need my family",
  "call my family",
  "get my family",
  "call my daughter",
  "call my son",
  "call my caregiver",
  "call my wife",
  "call my husband",
  "help now",
  "please help",
  "i need help",
];

const IMMEDIATE_DISTRESS_PHRASES = [
  "im hurt",
  "i am hurt",
  "i fell",
  "ive fallen",
  "i have fallen",
  "injured",
  "in trouble",
  "help me",
  "emergency",
];

export function normalizeCrisisMessage(message: string): string {
  return message
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findMatches(normalizedMessage: string, phrases: string[]): string[] {
  return phrases.filter((phrase) => normalizedMessage.includes(phrase));
}

export function detectCrisis(message: string): CrisisDetectionResult {
  const normalizedMessage = normalizeCrisisMessage(message);
  if (!normalizedMessage) {
    return { triggered: false, normalizedMessage, matchedPhrases: [] };
  }

  const distressMatches = findMatches(normalizedMessage, DISTRESS_PHRASES);
  const actionMatches = findMatches(normalizedMessage, ACTION_PHRASES);
  const immediateDistressMatches = findMatches(normalizedMessage, IMMEDIATE_DISTRESS_PHRASES);

  const triggered =
    (distressMatches.length > 0 && actionMatches.length > 0) ||
    immediateDistressMatches.length > 0;

  if (!triggered) {
    return {
      triggered: false,
      normalizedMessage,
      matchedPhrases: [...distressMatches, ...actionMatches],
    };
  }

  return {
    triggered: true,
    reason: "high-confidence distress phrase detected",
    severity: "high",
    normalizedMessage,
    matchedPhrases: [...new Set([...distressMatches, ...actionMatches])],
  };
}
