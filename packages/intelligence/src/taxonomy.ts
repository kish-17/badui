import type { CategoryId, Essentiality } from "@brake/core";
import type { CategoryDefinition, LabelOption } from "./contracts";

/**
 * BRAKE's spending taxonomy: deliberately small, two levels, and separate
 * from transaction *type* (transfer, refund…) and *ownership* (work, shared…).
 * Essentiality priors are population defaults that personal learning overrides.
 */
export const UNCATEGORIZED: CategoryId = "uncategorized";

const E = (essential: number, semi: number, discretionary: number) => ({
  essential,
  semi_discretionary: semi,
  discretionary,
});

export const CATEGORIES: readonly CategoryDefinition[] = [
  { id: "groceries", label: "Groceries", essentiality: E(0.75, 0.2, 0.05) },
  { id: "eating_out", label: "Eating out", essentiality: E(0.05, 0.35, 0.6) },
  { id: "eating_out.restaurant", label: "Restaurants", parent: "eating_out", essentiality: E(0.03, 0.3, 0.67) },
  { id: "eating_out.delivery", label: "Food delivery", parent: "eating_out", essentiality: E(0.05, 0.3, 0.65) },
  { id: "eating_out.cafe", label: "Cafés", parent: "eating_out", essentiality: E(0.02, 0.28, 0.7) },
  { id: "shopping", label: "Shopping", essentiality: E(0.1, 0.3, 0.6) },
  { id: "shopping.electronics", label: "Electronics", parent: "shopping", essentiality: E(0.1, 0.3, 0.6) },
  { id: "shopping.clothing", label: "Clothing", parent: "shopping", essentiality: E(0.1, 0.35, 0.55) },
  { id: "shopping.online_marketplace", label: "Online shopping", parent: "shopping", essentiality: E(0.15, 0.35, 0.5) },
  { id: "household", label: "Household", essentiality: E(0.5, 0.4, 0.1) },
  { id: "personal_care", label: "Personal care", essentiality: E(0.25, 0.5, 0.25) },
  { id: "health", label: "Medical", essentiality: E(0.85, 0.12, 0.03), sensitive: true },
  { id: "bills", label: "Bills", essentiality: E(0.85, 0.12, 0.03) },
  { id: "bills.utilities", label: "Utilities", parent: "bills", essentiality: E(0.95, 0.04, 0.01) },
  { id: "bills.phone_internet", label: "Phone & internet", parent: "bills", essentiality: E(0.8, 0.17, 0.03) },
  { id: "bills.insurance", label: "Insurance", parent: "bills", essentiality: E(0.9, 0.09, 0.01) },
  { id: "housing", label: "Housing", essentiality: E(0.9, 0.08, 0.02) },
  { id: "housing.rent", label: "Rent", parent: "housing", essentiality: E(0.98, 0.02, 0) },
  { id: "transport", label: "Transport", essentiality: E(0.6, 0.3, 0.1) },
  { id: "transport.fuel", label: "Fuel", parent: "transport", essentiality: E(0.7, 0.25, 0.05) },
  { id: "transport.public", label: "Public transport", parent: "transport", essentiality: E(0.85, 0.13, 0.02) },
  { id: "transport.rideshare", label: "Taxis & rides", parent: "transport", essentiality: E(0.2, 0.5, 0.3) },
  { id: "entertainment", label: "Entertainment", essentiality: E(0.02, 0.18, 0.8) },
  { id: "entertainment.streaming", label: "Streaming", parent: "entertainment", essentiality: E(0.05, 0.35, 0.6) },
  { id: "entertainment.events", label: "Events & movies", parent: "entertainment", essentiality: E(0.01, 0.14, 0.85) },
  { id: "entertainment.gaming", label: "Gaming", parent: "entertainment", essentiality: E(0.01, 0.09, 0.9) },
  { id: "entertainment.gambling", label: "Betting", parent: "entertainment", essentiality: E(0, 0.05, 0.95), sensitive: true },
  { id: "digital", label: "Apps & software", essentiality: E(0.15, 0.45, 0.4) },
  { id: "travel", label: "Travel", essentiality: E(0.1, 0.3, 0.6) },
  { id: "travel.flights", label: "Flights", parent: "travel", essentiality: E(0.15, 0.3, 0.55) },
  { id: "travel.lodging", label: "Hotels & stays", parent: "travel", essentiality: E(0.1, 0.3, 0.6) },
  { id: "education", label: "Education", essentiality: E(0.7, 0.25, 0.05) },
  { id: "gifts", label: "Gifts", essentiality: E(0.05, 0.45, 0.5) },
  { id: "donations", label: "Donations", essentiality: E(0.05, 0.35, 0.6), sensitive: true },
  { id: "pets", label: "Pets", essentiality: E(0.45, 0.4, 0.15) },
  { id: "fees", label: "Fees & charges", essentiality: E(0.5, 0.4, 0.1) },
  { id: "taxes", label: "Taxes", essentiality: E(1, 0, 0) },
  { id: "other", label: "Other", essentiality: E(0.33, 0.34, 0.33) },
  { id: UNCATEGORIZED, label: "Uncategorized", essentiality: E(0.33, 0.34, 0.33) },
];

const BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

export function getCategory(id: CategoryId): CategoryDefinition | undefined {
  return BY_ID.get(id);
}

export function categoryLabel(id: CategoryId): string {
  return BY_ID.get(id)?.label ?? BY_ID.get(topLevelCategory(id))?.label ?? "Other";
}

/** "shopping.electronics" -> "shopping". */
export function topLevelCategory(id: CategoryId): CategoryId {
  const dot = id.indexOf(".");
  return dot < 0 ? id : id.slice(0, dot);
}

export function isKnownCategory(id: CategoryId): boolean {
  return BY_ID.has(id);
}

/** True for special-category spending (see CategoryDefinition.sensitive); a sensitive parent makes its children sensitive. */
export function isSensitiveCategory(id: CategoryId): boolean {
  return BY_ID.get(id)?.sensitive === true || BY_ID.get(topLevelCategory(id))?.sensitive === true;
}

/**
 * ISO 18245 codes whose mere presence reveals special-category data
 * (research docs 11 and 13): political organisations, religious
 * organisations, doctors/hospitals/medical services, pharmacies, dating and
 * escort services, betting. Never in telemetry, copy or off-device training.
 */
export const SENSITIVE_MCCS: ReadonlySet<string> = new Set(["8651", "8661", "8011", "8062", "8099", "5912", "7273", "7995"]);

/** Most likely essentiality for a category under the population prior. */
export function defaultEssentiality(id: CategoryId): Exclude<Essentiality, "unknown"> {
  const def = BY_ID.get(id) ?? BY_ID.get(topLevelCategory(id));
  if (!def) return "semi_discretionary";
  let best: Exclude<Essentiality, "unknown"> = "semi_discretionary";
  let bestP = -1;
  for (const [k, p] of Object.entries(def.essentiality) as Array<[Exclude<Essentiality, "unknown">, number]>) {
    if (p > bestP) {
      best = k;
      bestP = p;
    }
  }
  return best;
}

/**
 * One-tap answers. The brief's quick-action list mixes categories, types and
 * ownership; each option here records its precise effect.
 */
export const LABEL_OPTIONS: readonly LabelOption[] = [
  { id: "groceries", label: "Groceries", effect: { field: "category", value: "groceries" } },
  { id: "eating_out", label: "Eating out", effect: { field: "category", value: "eating_out" } },
  { id: "shopping", label: "Shopping", effect: { field: "category", value: "shopping" } },
  { id: "household", label: "Household", effect: { field: "category", value: "household" } },
  { id: "bills", label: "Bills", effect: { field: "category", value: "bills" } },
  { id: "rent", label: "Rent", effect: { field: "category", value: "housing.rent" } },
  { id: "transport", label: "Transport", effect: { field: "category", value: "transport" } },
  { id: "entertainment", label: "Entertainment", effect: { field: "category", value: "entertainment" } },
  { id: "medical", label: "Medical", effect: { field: "category", value: "health" } },
  { id: "personal_care", label: "Personal care", effect: { field: "category", value: "personal_care" } },
  { id: "education", label: "Education", effect: { field: "category", value: "education" } },
  { id: "gift", label: "Gift", effect: { field: "category", value: "gifts" } },
  { id: "travel", label: "Travel", effect: { field: "category", value: "travel" } },
  { id: "apps", label: "Apps", effect: { field: "category", value: "digital" } },
  { id: "work", label: "Work", effect: { field: "ownership", value: "business" } },
  { id: "reimbursable", label: "Reimbursable", effect: { field: "ownership", value: "reimbursable" } },
  { id: "shared", label: "Shared", effect: { field: "ownership", value: "shared" } },
  { id: "transfer", label: "Transfer", effect: { field: "transaction_type", value: "transfer" } },
  { id: "own_transfer", label: "My account", effect: { field: "transaction_type", value: "transfer", transferKind: "own_account" } },
  { id: "family_transfer", label: "Family", effect: { field: "transaction_type", value: "transfer", transferKind: "family" } },
  { id: "subscription", label: "Subscription", effect: { field: "transaction_type", value: "subscription" } },
  { id: "refund", label: "Refund", effect: { field: "transaction_type", value: "refund" } },
  { id: "investment", label: "Investment", effect: { field: "transaction_type", value: "investment" } },
  { id: "card_bill", label: "Card bill", effect: { field: "transaction_type", value: "credit_card_payment" } },
  { id: "loan", label: "Loan/EMI", effect: { field: "transaction_type", value: "loan_payment" } },
  { id: "other", label: "Other", effect: { field: "category", value: "other" } },
];

/** Overflow option shown last when the surface cannot show every choice; opens the full picker. */
export const MORE_OPTION: LabelOption = {
  id: "more",
  label: "Other…",
  effect: { field: "category", value: "other" },
  opensPicker: true,
};

export const SATISFACTION_OPTIONS: readonly LabelOption[] = [
  { id: "worth_it", label: "Yes", effect: { field: "satisfaction", value: "worth_it" } },
  { id: "neutral", label: "Neutral", effect: { field: "satisfaction", value: "neutral" } },
  { id: "regretted", label: "Regret it", effect: { field: "satisfaction", value: "regretted" } },
];

const OPTION_BY_ID = new Map([...LABEL_OPTIONS, MORE_OPTION].map((o) => [o.id, o]));

export function labelOption(id: string): LabelOption | undefined {
  return OPTION_BY_ID.get(id);
}

/** The label option that best represents a category (falls back to its top-level option). */
export function optionForCategory(id: CategoryId): LabelOption | undefined {
  return (
    LABEL_OPTIONS.find((o) => o.effect.field === "category" && o.effect.value === id) ??
    LABEL_OPTIONS.find((o) => o.effect.field === "category" && o.effect.value === topLevelCategory(id))
  );
}
