import { it } from "vitest";
import { scrubDescriptor, last4Of, parseDecimalAmount, parseInstant } from "../src/ledger-mapping";
it("probe2", () => {
  for (const s of ["SEPA CT DE89370400440532013000 MAX MUSTERMANN", "IBAN GB29 NWBK 6016 1331 9268 19", "GB29NWBK60161331926819 rent", "REF 12345678901234567890 ACME", "TFR 20-45-77 12345678 J SMITH", "TO A/C 12345678 SAVINGS", "NL91ABNA0417164300 Albert Heijn", "FR1420041010050500013M02606 loyer", "4111 1111 1111 1111 test", "Card 5555555555554444"])
    console.log(JSON.stringify(s), "=>", JSON.stringify(scrubDescriptor(s)));
  console.log(last4Of("Savings 2025"), last4Of("•••• 1234"), last4Of("Apple Card"));
  console.log(JSON.stringify(parseDecimalAmount("1,249.00", "INR")), JSON.stringify(parseDecimalAmount(" 1249.5 ", "INR")), JSON.stringify(parseDecimalAmount("-0.005", "USD")), JSON.stringify(parseDecimalAmount(0.1 + 0.2, "USD")), JSON.stringify(parseDecimalAmount(1e21, "USD")), JSON.stringify(parseDecimalAmount("12.345", "KWD")), JSON.stringify(parseDecimalAmount("1249", "JPY")), JSON.stringify(parseDecimalAmount("12.5", "JPY")));
  console.log(JSON.stringify(parseInstant("2026-10-04T10:41:00.123456+05:30")), JSON.stringify(parseInstant("2026-10-04T10:41:00Z", { midnightIsDate: true })), JSON.stringify(parseInstant(1759574400)), JSON.stringify(parseInstant("1759574400")), JSON.stringify(parseInstant("2026-10-04T24:00:00Z")), JSON.stringify(parseInstant("2026-10-04")));
});
