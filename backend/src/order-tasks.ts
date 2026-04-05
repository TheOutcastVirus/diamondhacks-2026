// Structured browser task strings for food and pharmacy ordering.
// Adapted from SeeFood (sodium).

export type OrderCard = {
  card: string;
  exp_month: string | number;
  exp_year: string | number;
  cvv?: string;
  name?: string;
  billing_zip?: string;
};

export type OrderItem = {
  name: string;
  quantity?: number;
  notes?: string;
};

export type FoodOrderParams = {
  platform: "doordash" | "ubereats" | "grubhub";
  merchant: string;
  items: OrderItem[];
  deliveryAddress?: string;
  card?: OrderCard;
};

export type CvsOrderParams = {
  items: OrderItem[];
  deliveryAddress?: string;
  card?: OrderCard;
  pickupStore?: string;
};

const FOOD_PLATFORM_URLS: Record<FoodOrderParams["platform"], string> = {
  doordash: "https://www.doordash.com",
  ubereats: "https://www.ubereats.com",
  grubhub: "https://www.grubhub.com",
};

export function buildFoodOrderTask(params: FoodOrderParams): string {
  const url = FOOD_PLATFORM_URLS[params.platform];
  const platformName =
    params.platform === "doordash"
      ? "DoorDash"
      : params.platform === "ubereats"
        ? "Uber Eats"
        : "Grubhub";
  const itemList = params.items.map((item) => {
    const qty = item.quantity && item.quantity > 1 ? `${item.quantity}x ` : "";
    const notes = item.notes ? ` (${item.notes})` : "";
    return `${qty}${item.name}${notes}`;
  });
  const cardInfo = params.card
    ? `Card: ${params.card.card} exp ${params.card.exp_month}/${params.card.exp_year}${params.card.cvv ? ` CVV ${params.card.cvv}` : ""}.`
    : "";
  const addressInfo = params.deliveryAddress
    ? `Deliver to: ${params.deliveryAddress}.`
    : "";

  return [
    `Go to ${url} (${platformName}) and place a delivery order from "${params.merchant}".`,
    `Add these items to the cart: ${itemList.join(", ")}.`,
    addressInfo,
    cardInfo,
    "Proceed through checkout. If any substitution, timing, or confirmation is needed, stop and report what is required.",
    "When you have the final result, stop browsing and end the session (do not keep it open).",
    "Return JSON: { status: 'placed' | 'blocked', orderNumber?: string, total?: string, estimatedArrival?: string, blockedReason?: string }",
  ]
    .filter(Boolean)
    .join(" ");
}

export function buildCvsTask(params: CvsOrderParams): string {
  const itemList = params.items.map((item) => {
    const qty = item.quantity && item.quantity > 1 ? `${item.quantity}x ` : "";
    const notes = item.notes ? ` (${item.notes})` : "";
    // rx: prefix signals a prescription refill item
    return `${qty}${item.name}${notes}`;
  });
  const deliveryMode = params.deliveryAddress
    ? `Ship to: ${params.deliveryAddress}.`
    : params.pickupStore
      ? `Pick up at CVS store: ${params.pickupStore}.`
      : "Use the saved delivery address or pick up at the nearest store.";
  const cardInfo = params.card
    ? `Card: ${params.card.card} exp ${params.card.exp_month}/${params.card.exp_year}${params.card.cvv ? ` CVV ${params.card.cvv}` : ""}.`
    : "";

  return [
    "Go to https://www.cvs.com and sign in with the saved account.",
    `Order the following items: ${itemList.join(", ")}.`,
    "For any item prefixed with 'rx:' use the pharmacy refill flow (Pharmacy > Manage Prescriptions > Refill). Use the Rx number provided.",
    "For OTC items add them to the cart from the shop.",
    deliveryMode,
    cardInfo,
    "Complete checkout. If anything is missing, out of stock, or requires input, stop and report clearly.",
    "When you have the final result, stop browsing and end the session (do not keep it open).",
    "Return JSON: { status: 'placed' | 'blocked', orderNumber?: string, total?: string, estimatedArrival?: string, blockedReason?: string }",
  ]
    .filter(Boolean)
    .join(" ");
}

const FOOD_PLATFORM_KEYWORDS: Record<FoodOrderParams["platform"], string[]> = {
  doordash: ["doordash", "door dash"],
  ubereats: ["uber eats", "ubereats", "uber eat"],
  grubhub: ["grubhub", "grub hub"],
};

export function detectFoodPlatform(task: string): FoodOrderParams["platform"] | undefined {
  const lower = task.toLowerCase();
  for (const [platform, keywords] of Object.entries(FOOD_PLATFORM_KEYWORDS) as [
    FoodOrderParams["platform"],
    string[],
  ][]) {
    if (keywords.some((kw) => lower.includes(kw))) {
      return platform;
    }
  }
  return undefined;
}

export function isCvsTask(task: string): boolean {
  return /\bcvs\b/i.test(task);
}
