// Structured browser task strings for food and pharmacy ordering.
// Adapted from SeeFood (gazabot).

/** Many sites (Walmart, grocers, etc.) leave the agent on a product or cart drawer unless checkout is clicked explicitly. */
export const OPEN_CHECKOUT_FLOW =
  "After items are in the cart, open the full cart or bag (not only a mini-cart preview), then click the primary checkout control (Checkout, Proceed to checkout, Check out, Start checkout, or View cart / Bag then Checkout). Continue until the checkout page or checkout step loads. Do not end the session while checkout has not been opened.";

/** When the task does not include a card, stop before typing payment; report success once checkout (incl. address step) is open. */
export const CHECKOUT_LIVE_BROWSER_HANDOFF =
  "No payment card was included in this task: do not enter card details or click Place order yourself. Navigate through to checkout. When checkout is visible—including shipping, delivery, or address fields—return JSON with status 'success' and summary briefly describing the step (e.g. 'At shipping address—add payment in Requested Info or finish in the live view'). Use status 'blocked' only if you cannot reach checkout (login, errors, out of stock).";

/** When payment details are in the task: milestone success at address/shipping, not blocked. */
export const CHECKOUT_SUCCESS_WITH_PAYMENT_INSTRUCTION =
  "Payment and delivery information are included in this task. When checkout opens, you will have what you need to complete it. Proceed through all checkout steps: enter/confirm delivery address if prompted, enter the payment card details provided, and submit the order. Return JSON with status 'success' when you reach a checkout field (address, payment, shipping method, etc.) and have successfully entered the provided information. Return status 'placed' only after the order submission is complete and you see an order confirmation (confirmation page, email prompt, order number, etc.). Use status 'blocked' only if you cannot proceed (sign-in required, item unavailable, payment declined, etc.).";

/** Standard structured result shape for browser ordering tasks. */
export const RETURN_CHECKOUT_JSON_SCHEMA =
  "Return JSON: { status: 'placed' | 'success' | 'blocked', summary?: string, orderNumber?: string, total?: string, estimatedArrival?: string, blockedReason?: string }";

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

export type GenericRetailOrderParams = {
  merchant: string;
  itemName: string;
  card?: OrderCard;
  deliveryAddress?: string;
};

export function buildGenericOrderTemplate(
  merchant: string,
  itemName: string,
  extras?: { card?: OrderCard; deliveryAddress?: string },
): string {
  const card = extras?.card;
  const deliveryAddress = extras?.deliveryAddress;
  const cardInfo = card
    ? `Card: ${card.card} exp ${card.exp_month}/${card.exp_year}${card.cvv ? ` CVV ${card.cvv}` : ""}.`
    : "";
  const addressInfo = deliveryAddress ? `Shipping or delivery address: ${deliveryAddress}.` : "";

  return [
    `Go to ${merchant} (e.g. walmart.com or the store's official site) and order ${itemName} for the household.`,
    "Reuse the saved browser profile if available.",
    "Add only the requested item to the cart.",
    addressInfo,
    cardInfo,
    OPEN_CHECKOUT_FLOW,
    ...(card ? [CHECKOUT_SUCCESS_WITH_PAYMENT_INSTRUCTION] : [CHECKOUT_LIVE_BROWSER_HANDOFF]),
    "If sign-in, substitutions, delivery slot, or other info is needed before checkout, stop and clearly report what is required.",
    "When you have the final result, stop browsing and end the session (do not keep it open).",
    RETURN_CHECKOUT_JSON_SCHEMA,
  ]
    .filter(Boolean)
    .join(" ");
}

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
    OPEN_CHECKOUT_FLOW,
    "Proceed through checkout. If any substitution, timing, or confirmation is needed, stop and report what is required.",
    ...(params.card ? [CHECKOUT_SUCCESS_WITH_PAYMENT_INSTRUCTION] : [CHECKOUT_LIVE_BROWSER_HANDOFF]),
    "When you have the final result, stop browsing and end the session (do not keep it open).",
    RETURN_CHECKOUT_JSON_SCHEMA,
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
    OPEN_CHECKOUT_FLOW,
    "Complete checkout. If anything is missing, out of stock, or requires input, stop and report clearly.",
    ...(params.card ? [CHECKOUT_SUCCESS_WITH_PAYMENT_INSTRUCTION] : [CHECKOUT_LIVE_BROWSER_HANDOFF]),
    "When you have the final result, stop browsing and end the session (do not keep it open).",
    RETURN_CHECKOUT_JSON_SCHEMA,
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
