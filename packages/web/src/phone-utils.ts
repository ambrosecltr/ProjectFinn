import type { CountryCode } from "./web-types";

export const countries = [
  { code: "AU", name: "Australia", flag: "🇦🇺", prefix: "+61", placeholder: "0412 345 678" },
  { code: "CN", name: "China", flag: "🇨🇳", prefix: "+86", placeholder: "131 2345 6789" },
  { code: "US", name: "United States", flag: "🇺🇸", prefix: "+1", placeholder: "(555) 123-4567" },
  { code: "CA", name: "Canada", flag: "🇨🇦", prefix: "+1", placeholder: "(555) 123-4567" },
] as const;

export function formatPhoneForCountry(value: string, countryCode: CountryCode): string {
  const digits = value.replace(/\D/g, "");

  if (countryCode === "AU") {
    const localDigits = digits.startsWith("61") ? `0${digits.slice(2)}` : digits;
    return [
      localDigits.slice(0, 4),
      localDigits.slice(4, 7),
      localDigits.slice(7, 10),
    ].filter(Boolean).join(" ");
  }

  if (countryCode === "CN") {
    const localDigits = digits.startsWith("86") ? digits.slice(2) : digits;
    return [
      localDigits.slice(0, 3),
      localDigits.slice(3, 7),
      localDigits.slice(7, 11),
    ].filter(Boolean).join(" ");
  }

  const localDigits = digits.length > 10 && digits.startsWith("1") ? digits.slice(1) : digits;
  const area = localDigits.slice(0, 3);
  const exchange = localDigits.slice(3, 6);
  const line = localDigits.slice(6, 10);

  if (localDigits.length <= 3) return area;
  if (localDigits.length <= 6) return `(${area}) ${exchange}`;
  return `(${area}) ${exchange}-${line}`;
}

export function normalizePhoneForCountry(value: string, countryCode: CountryCode): string {
  const country = countries.find((item) => item.code === countryCode) ?? countries[0];
  const trimmed = value.trim();

  if (trimmed.startsWith("+")) {
    return `+${trimmed.slice(1).replace(/\D/g, "")}`;
  }

  const digits = trimmed.replace(/\D/g, "");

  if (!digits) {
    return "";
  }

  if (country.code === "AU") {
    if (digits.startsWith("0")) {
      return `${country.prefix}${digits.slice(1)}`;
    }

    if (digits.startsWith("61")) {
      return `+${digits}`;
    }
  }

  if ((country.code === "US" || country.code === "CA") && digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }

  if (country.code === "CN" && digits.startsWith("86")) {
    return `+${digits}`;
  }

  return `${country.prefix}${digits}`;
}

export function inferCountryCodeFromPhone(value: string): CountryCode {
  const normalized = value.trim().startsWith("+")
    ? `+${value.trim().slice(1).replace(/\D/g, "")}`
    : value.replace(/\D/g, "");

  if (normalized.startsWith("+61") || normalized.startsWith("61") || normalized.startsWith("04")) {
    return "AU";
  }

  if (normalized.startsWith("+86") || normalized.startsWith("86")) {
    return "CN";
  }

  if (normalized.startsWith("+1") || normalized.startsWith("1")) {
    return "US";
  }

  return "AU";
}
